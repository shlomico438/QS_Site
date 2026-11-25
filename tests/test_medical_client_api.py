"""Compatibility contract for the website and standalone medical client."""

from __future__ import annotations

import unittest
from unittest.mock import patch

import aws_transcribe_stream
import siteapp


LONG_TRANSCRIPT = (
    "המטופל מתאר כאבים בגב התחתון במשך שבועיים עם החמרה בתנועה. "
    "בבדיקה קיימת רגישות מקומית ללא חסר נוירולוגי. הומלץ על טיפול ומעקב."
)

FORMATTED = {
    "clean_transcript": "תמלול מתוקן",
    "overview": "רקע",
    "key_points": ["נקודה"],
    "action_items": [],
    "medical_chief_complaint": "תלונה",
    "medical_examination_transcript": "בדיקה",
    "medical_patient_recommendations": "המלצה",
}


class SharedMedicalPipelineTests(unittest.TestCase):
    def test_short_transcript_uses_shared_guardrail_without_model_call(self):
        with patch.object(siteapp, "_format_transcript_and_summary_via_openai") as model, \
             patch.object(siteapp, "_doctor_prompt_profile_active_prompt", return_value=None):
            out = siteapp.process_medical_transcript("בדיקה 1 2 3", user_id="doctor-1")
        model.assert_not_called()
        self.assertEqual(out["format_guardrail"], "medical_short_transcript_bypass")
        self.assertEqual(out["clean_transcript"], "בדיקה 1 2 3")

    def test_long_transcript_delegates_to_existing_unified_pipeline(self):
        with patch.object(
            siteapp,
            "_format_transcript_and_summary_via_openai",
            return_value=FORMATTED,
        ) as model:
            out = siteapp.process_medical_transcript(
                LONG_TRANSCRIPT,
                target_lang="he",
                user_id="doctor-1",
                prior_formatted={"medical_chief_complaint": "קודם"},
            )
        self.assertIs(out, FORMATTED)
        kwargs = model.call_args.kwargs
        self.assertTrue(kwargs["is_medical"])
        self.assertEqual(kwargs["user_id"], "doctor-1")
        self.assertEqual(kwargs["target_lang"], "he")

    def test_existing_web_route_keeps_legacy_payload_shape(self):
        with patch.object(siteapp, "_supabase_user_id_from_request", return_value="doctor-1"), \
             patch.object(siteapp, "process_medical_transcript", return_value=FORMATTED) as shared:
            response = siteapp.app.test_client().post(
                "/api/format_transcript_summary",
                json={
                    "isMedical": True,
                    "mode": "summary",
                    "text": LONG_TRANSCRIPT,
                    "userId": "doctor-1",
                },
                headers={"Authorization": "Bearer token"},
            )
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["clean_transcript"], "תמלול מתוקן")
        self.assertEqual(payload["medical_chief_complaint"], "תלונה")
        self.assertIn("gpt_format_sec", payload)
        shared.assert_called_once()


class MedicalClientApiTests(unittest.TestCase):
    def _allowed(self, data):
        return "doctor-1", None

    def test_config_is_secret_free_and_describes_fallback(self):
        with patch.object(siteapp, "_medical_client_require_access", side_effect=self._allowed):
            response = siteapp.app.test_client().get("/api/medical/client/v1/config")
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["stream"]["transport"], "socketio")
        self.assertEqual(payload["fallback"]["archivePath"], "/api/medical/archive_recording")
        self.assertIn("chrome_block", payload["microphone"]["causes"])
        self.assertEqual(
            payload["microphone"]["recoveryPathTemplate"],
            "/api/medical/mic-event/{eventId}/recovered",
        )
        self.assertNotIn("accessToken", str(payload))
        self.assertNotIn("secret", str(payload).lower())

    def test_process_uses_authenticated_user_and_shared_pipeline(self):
        with patch.object(siteapp, "_medical_client_require_access", side_effect=self._allowed), \
             patch.object(siteapp, "process_medical_transcript", return_value=FORMATTED) as shared:
            response = siteapp.app.test_client().post(
                "/api/medical/client/v1/process",
                json={"jobId": "job-1", "transcript": LONG_TRANSCRIPT},
                headers={"Authorization": "Bearer token"},
            )
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["jobId"], "job-1")
        self.assertEqual(payload["correctedTranscript"], "תמלול מתוקן")
        self.assertEqual(payload["sections"]["medical_patient_recommendations"], "המלצה")
        self.assertEqual(shared.call_args.kwargs["user_id"], "doctor-1")

    def test_pipeline_failure_log_does_not_contain_medical_text(self):
        sentinel = "SENTINEL_PATIENT_TRANSCRIPT"
        with patch.object(siteapp, "_medical_client_require_access", side_effect=self._allowed), \
             patch.object(siteapp, "process_medical_transcript", side_effect=RuntimeError(sentinel)), \
             self.assertLogs(level="ERROR") as captured:
            response = siteapp.app.test_client().post(
                "/api/medical/client/v1/process",
                json={"jobId": "job-privacy", "transcript": sentinel},
                headers={"Authorization": "Bearer token"},
            )
        self.assertEqual(response.status_code, 502)
        self.assertNotIn(sentinel, "\n".join(captured.output))

    def test_origin_allowlist_is_closed_for_unconfigured_extensions(self):
        with patch.dict("os.environ", {"MEDICAL_EXTENSION_IDS": "allowedextension"}, clear=False):
            self.assertTrue(siteapp._medical_extension_origin_allowed("chrome-extension://allowedextension"))
            self.assertFalse(siteapp._medical_extension_origin_allowed("chrome-extension://attacker"))
            self.assertFalse(siteapp._medical_extension_origin_allowed("https://evil.example"))
            # Desktop helper / MV3: empty Origin is allowed (bearer still required).
            self.assertTrue(siteapp._medical_extension_origin_allowed(""))
            self.assertTrue(aws_transcribe_stream.medical_extension_socket_origin_allowed(
                {"client": "extension"}, "chrome-extension://allowedextension"
            ))
            self.assertFalse(aws_transcribe_stream.medical_extension_socket_origin_allowed(
                {"client": "extension"}, "chrome-extension://attacker"
            ))
            # Existing web clients do not declare extension mode and are unchanged.
            self.assertTrue(aws_transcribe_stream.medical_extension_socket_origin_allowed(
                {}, "https://quickscribe.co.il"
            ))

    def test_mismatched_body_user_is_rejected(self):
        with patch.object(
            siteapp,
            "_enforce_medical_request_entitlement",
            return_value=(True, "doctor-1", None),
        ):
            response = siteapp.app.test_client().post(
                "/api/medical/client/v1/process",
                json={"userId": "doctor-2", "transcript": LONG_TRANSCRIPT},
                headers={"Authorization": "Bearer token"},
            )
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.get_json()["error"], "user_mismatch")

    def test_entitlement_error_is_forwarded_without_running_pipeline(self):
        with siteapp.app.app_context():
            denied = (siteapp.jsonify({"error": "trial_usage_exhausted"}), 403)
        with patch.object(
            siteapp,
            "_enforce_medical_request_entitlement",
            return_value=(True, "doctor-1", denied),
        ), patch.object(siteapp, "process_medical_transcript") as shared:
            response = siteapp.app.test_client().post(
                "/api/medical/client/v1/process",
                json={"transcript": LONG_TRANSCRIPT},
                headers={"Authorization": "Bearer token"},
            )
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.get_json()["error"], "trial_usage_exhausted")
        shared.assert_not_called()

    def test_pipeline_failure_does_not_log_or_return_medical_text(self):
        sentinel = "PATIENT-SENTINEL-SECRET"
        with patch.object(siteapp, "_medical_client_require_access", side_effect=self._allowed), \
             patch.object(
                 siteapp,
                 "process_medical_transcript",
                 side_effect=RuntimeError(sentinel),
             ), self.assertLogs(level="ERROR") as captured:
            response = siteapp.app.test_client().post(
                "/api/medical/client/v1/process",
                json={"jobId": "job-privacy", "transcript": sentinel},
                headers={"Authorization": "Bearer token"},
            )
        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.get_json()["error"], "medical_processing_failed")
        self.assertNotIn(sentinel, "\n".join(captured.output))
        self.assertNotIn(sentinel, response.get_data(as_text=True))

    def test_finalize_reuses_web_completion_then_shared_pipeline(self):
        with siteapp.app.app_context():
            completed_response = siteapp.jsonify({"status": "completed", "engine": "aws_transcribe_stream"})
        with patch.object(siteapp, "_medical_client_require_access", side_effect=self._allowed), \
             patch.object(
                 siteapp,
                 "api_medical_complete_stream_transcription",
                 return_value=(completed_response, 200),
             ) as complete, \
             patch.object(siteapp, "process_medical_transcript", return_value=FORMATTED) as shared:
            response = siteapp.app.test_client().post(
                "/api/medical/client/v1/finalize",
                json={
                    "jobId": "job-1",
                    "s3Key": "raw-audio/users/doctor-1/job-1.webm",
                    "transcript": LONG_TRANSCRIPT,
                    "durationSec": 60,
                },
                headers={"Authorization": "Bearer token"},
            )
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()["transcriptionFinalized"])
        complete.assert_called_once()
        shared.assert_called_once()

    def test_finalize_retry_does_not_repeat_stream_completion_or_usage_path(self):
        job_id = "job-retry"
        old_result = siteapp.job_results_cache.get(job_id)
        old_info = siteapp.pending_job_info.get(job_id)
        siteapp.job_results_cache[job_id] = {
            "jobId": job_id,
            "status": "completed",
            "engine": "aws_transcribe_stream",
        }
        siteapp.pending_job_info[job_id] = {"user_id": "doctor-1"}
        try:
            with patch.object(siteapp, "_medical_client_require_access", side_effect=self._allowed), \
                 patch.object(siteapp, "api_medical_complete_stream_transcription") as complete, \
                 patch.object(siteapp, "process_medical_transcript", return_value=FORMATTED):
                response = siteapp.app.test_client().post(
                    "/api/medical/client/v1/finalize",
                    json={
                        "jobId": job_id,
                        "s3Key": "raw-audio/users/doctor-1/job-retry.webm",
                        "transcript": LONG_TRANSCRIPT,
                        "durationSec": 60,
                    },
                    headers={"Authorization": "Bearer token"},
                )
            self.assertEqual(response.status_code, 200)
            complete.assert_not_called()
        finally:
            if old_result is None:
                siteapp.job_results_cache.pop(job_id, None)
            else:
                siteapp.job_results_cache[job_id] = old_result
            if old_info is None:
                siteapp.pending_job_info.pop(job_id, None)
            else:
                siteapp.pending_job_info[job_id] = old_info


if __name__ == "__main__":
    unittest.main()
