#!/usr/bin/env python3
"""Unit tests for per-email entitlement ledger (welcome minutes + medical trial)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest import TestCase

from entitlement_ledger import (
    ledger_delete_snapshot_payload,
    medical_account_insert_payload,
    normalize_entitlement_email,
    welcome_minutes_for_ledger,
)

NOW = datetime(2026, 8, 18, 10, 0, tzinfo=timezone.utc)


class NormalizeEntitlementEmailTests(TestCase):
    def test_gmail_dots_and_plus_and_googlemail(self):
        self.assertEqual(
            normalize_entitlement_email("A.B.C+promo@Gmail.com"),
            "abc@gmail.com",
        )
        self.assertEqual(
            normalize_entitlement_email("abc@googlemail.com"),
            "abc@gmail.com",
        )

    def test_plus_stripped_on_yahoo(self):
        self.assertEqual(
            normalize_entitlement_email("shlomico+farm@yahoo.com"),
            "shlomico@yahoo.com",
        )

    def test_empty_and_invalid(self):
        self.assertEqual(normalize_entitlement_email(""), "")
        self.assertEqual(normalize_entitlement_email("not-an-email"), "")
        self.assertEqual(normalize_entitlement_email(" @gmail.com"), "")


class WelcomeMinutesForLedgerTests(TestCase):
    def test_first_signup_gets_sixty(self):
        self.assertEqual(welcome_minutes_for_ledger(None, 60), 60)
        self.assertEqual(welcome_minutes_for_ledger({"welcome_granted": False}, 60), 60)

    def test_returning_user_does_not_get_another_pack(self):
        self.assertEqual(
            welcome_minutes_for_ledger({"welcome_granted": True}, 60),
            0,
        )

    def test_returning_user_restores_leftover_snapshot(self):
        self.assertEqual(
            welcome_minutes_for_ledger(
                {"welcome_granted": True, "credit_minutes_snapshot": 40},
                60,
            ),
            40,
        )

    def test_used_up_then_deleted_restores_zero(self):
        self.assertEqual(
            welcome_minutes_for_ledger(
                {"welcome_granted": True, "credit_minutes_snapshot": 0},
                60,
            ),
            0,
        )


class MedicalPayloadFromLedgerTests(TestCase):
    def test_first_trial_is_fresh(self):
        payload = medical_account_insert_payload(
            "u1", "Dana", "Family", None, now=NOW
        )
        self.assertEqual(payload["subscription_plan"], "trial")
        self.assertEqual(payload["subscription_status"], "trialing")
        self.assertEqual(payload["included_seconds"], 30 * 3600)
        self.assertNotIn("trial_expires_at", payload)

    def test_used_trial_does_not_restart(self):
        payload = medical_account_insert_payload(
            "u1",
            "Dana",
            "Family",
            {
                "medical_trial_used": True,
                "medical_subscription_plan": "trial",
                "medical_subscription_status": "trialing",
                "medical_trial_expires_at": (NOW - timedelta(days=1)).isoformat(),
                "medical_usage_seconds": 0,
                "medical_included_seconds": 30 * 3600,
            },
            now=NOW,
        )
        self.assertEqual(payload["subscription_status"], "expired")
        self.assertLess(
            datetime.fromisoformat(payload["trial_expires_at"].replace("Z", "+00:00")),
            NOW,
        )

    def test_leftover_trial_is_restored(self):
        expires = NOW + timedelta(days=12)
        payload = medical_account_insert_payload(
            "u1",
            "Dana",
            "Family",
            {
                "medical_trial_used": True,
                "medical_subscription_plan": "trial",
                "medical_subscription_status": "trialing",
                "medical_trial_expires_at": expires.isoformat(),
                "medical_usage_seconds": 3600,
                "medical_included_seconds": 30 * 3600,
            },
            now=NOW,
        )
        self.assertEqual(payload["subscription_status"], "trialing")
        self.assertEqual(payload["current_period_usage_seconds"], 3600)

    def test_paid_plan_snapshot_is_restored(self):
        payload = medical_account_insert_payload(
            "u1",
            "Dana",
            "Family",
            {
                "medical_trial_used": True,
                "medical_subscription_plan": "starter",
                "medical_subscription_status": "active",
                "medical_included_seconds": 30 * 3600,
                "medical_usage_seconds": 100,
                "medical_billing_cycle_ends_at": (NOW + timedelta(days=20)).isoformat(),
            },
            now=NOW,
        )
        self.assertEqual(payload["subscription_plan"], "starter")
        self.assertEqual(payload["subscription_status"], "active")


class DeleteSnapshotTests(TestCase):
    def test_snapshot_keeps_remaining_minutes(self):
        payload = ledger_delete_snapshot_payload(
            "abc@gmail.com",
            "user-1",
            {"credit_minutes": 22, "welcome_granted": True},
            None,
            now=NOW,
        )
        self.assertEqual(payload["credit_minutes_snapshot"], 22)
        self.assertTrue(payload["welcome_granted"])
        self.assertNotIn("medical_trial_used", payload)
