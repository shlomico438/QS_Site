"""Medical microphone failure events: allowlist, privacy, and HTTP status."""

from __future__ import annotations

import unittest
from unittest.mock import patch

from medical_saas import (
    MedicalMicEventRejected,
    medical_mic_event_fields,
    medical_mic_recovery_seconds,
)


VALID = {
    "cause": "chrome_block",
    "phase": "start",
    "browser_family": "chrome",
    "os_family": "windows",
    "device_label": "USB Microphone",
    "session_id": "11111111-2222-4333-8444-555555555555",
}


class MedicalMicEventFieldTests(unittest.TestCase):
    def test_rejects_unknown_cause(self):
        payload = dict(VALID, cause="patient_visit")
        with self.assertRaises(MedicalMicEventRejected):
            medical_mic_event_fields(payload)

    def test_drops_client_user_and_transcript(self):
        payload = dict(VALID, user_id="attacker", transcript="patient said hello", ip="1.2.3.4")
        fields = medical_mic_event_fields(payload)
        self.assertEqual(set(fields), {
            "cause", "phase", "browser_family", "os_family", "device_label", "session_id",
        })
        self.assertNotIn("attacker", fields.values())
        self.assertNotIn("patient said hello", fields.values())

    def test_truncates_device_label(self):
        fields = medical_mic_event_fields(dict(VALID, device_label=("Mic " * 80)))
        self.assertEqual(len(fields["device_label"]), 120)

    def test_rejects_session_id_that_is_not_opaque(self):
        with self.assertRaises(MedicalMicEventRejected):
            medical_mic_event_fields(dict(VALID, session_id="visit 42 patient"))

    def test_recovery_seconds_must_be_a_whole_number(self):
        self.assertEqual(medical_mic_recovery_seconds({"recovery_seconds": 12}), 12)
        with self.assertRaises(MedicalMicEventRejected):
            medical_mic_recovery_seconds({"recovery_seconds": -1})
        with self.assertRaises(MedicalMicEventRejected):
            medical_mic_recovery_seconds({})


class MedicalMicEventRouteTests(unittest.TestCase):
    def test_invalid_cause_is_400_and_stores_nothing(self):
        import siteapp

        with patch("medical_saas.require_medical_entitlement") as auth, \
             patch("medical_saas._medical_mic_event_insert") as insert, \
             patch("medical_saas._medical_mic_event_count_last_hour") as count:
            res = siteapp.app.test_client().post(
                "/api/medical/mic-event",
                json=dict(VALID, cause="not-a-cause", user_id="attacker", transcript="secret"),
            )
        self.assertEqual(res.status_code, 400)
        auth.assert_not_called()
        count.assert_not_called()
        insert.assert_not_called()

    def test_insert_uses_the_session_user(self):
        import siteapp

        with patch(
            "medical_saas.require_medical_entitlement",
            return_value=("doctor-1", {}, None),
        ), patch(
            "medical_saas._medical_mic_event_count_last_hour",
            return_value=0,
        ), patch(
            "medical_saas._medical_mic_event_insert",
            return_value="event-1",
        ) as insert:
            res = siteapp.app.test_client().post(
                "/api/medical/mic-event",
                json=dict(VALID, user_id="attacker", device_label="A" * 200),
                headers={"Authorization": "Bearer session-token"},
            )
        self.assertEqual(res.status_code, 201)
        self.assertEqual(res.get_json(), {"id": "event-1"})
        user_id, fields = insert.call_args[0]
        self.assertEqual(user_id, "doctor-1")
        self.assertEqual(len(fields["device_label"]), 120)
        self.assertNotIn("user_id", fields)
        self.assertNotIn("transcript", fields)

    def test_rate_limit_does_not_insert(self):
        import siteapp

        with patch(
            "medical_saas.require_medical_entitlement",
            return_value=("doctor-1", {}, None),
        ), patch(
            "medical_saas._medical_mic_event_count_last_hour",
            return_value=30,
        ), patch("medical_saas._medical_mic_event_insert") as insert:
            res = siteapp.app.test_client().post(
                "/api/medical/mic-event",
                json=VALID,
                headers={"Authorization": "Bearer session-token"},
            )
        self.assertEqual(res.status_code, 429)
        insert.assert_not_called()

    def test_missing_login_is_401(self):
        import siteapp
        from flask import jsonify

        with siteapp.app.app_context():
            denied = (jsonify({"error": "medical_auth_required"}), 401)
        with patch(
            "medical_saas.require_medical_entitlement",
            return_value=(None, None, denied),
        ), patch("medical_saas._medical_mic_event_insert") as insert:
            res = siteapp.app.test_client().post("/api/medical/mic-event", json=VALID)
        self.assertEqual(res.status_code, 401)
        insert.assert_not_called()


if __name__ == "__main__":
    unittest.main()
