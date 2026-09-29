import unittest
from datetime import datetime, timedelta, timezone

from regular_billing import (
    clamp_pay_hours,
    coverage_for_minutes,
    gate_action,
    hours_for_minutes,
    resolve_offer,
    unlimited_is_active,
)


NOW = datetime(2026, 9, 27, 12, 0, tzinfo=timezone.utc)


class RegularBillingTests(unittest.TestCase):
    def test_prices(self):
        monthly = resolve_offer("unlimited_monthly")
        annual = resolve_offer("unlimited_annual")
        one_hour = resolve_offer("pay_per_use", 1)
        two_hours = resolve_offer("pay_per_use", 2)
        self.assertEqual(monthly["amount_ils"], 70)
        self.assertEqual(monthly["amount_usd"], 20)
        self.assertEqual(annual["amount_ils"], 420)
        self.assertEqual(annual["amount_usd"], 120)
        self.assertEqual(one_hour["amount_ils"], 9)
        self.assertEqual(two_hours["amount_ils"], 18)
        self.assertEqual(two_hours["credit_minutes"], 120)
        self.assertIsNone(resolve_offer("light"))

    def test_hours_clamp_and_file_length(self):
        self.assertEqual(clamp_pay_hours(0), 1)
        self.assertEqual(clamp_pay_hours(40), 24)
        self.assertEqual(hours_for_minutes(4), 1)
        self.assertEqual(hours_for_minutes(60), 1)
        self.assertEqual(hours_for_minutes(61), 2)

    def test_legacy_wallet_is_kept_until_empty(self):
        row = {"billing_plan": "legacy", "credit_minutes": 60, "welcome_granted": True}
        self.assertEqual(gate_action(row, now=NOW), "keep")
        self.assertEqual(coverage_for_minutes(row, 15, now=NOW)["source"], "wallet")

    def test_empty_legacy_starts_free_month(self):
        row = {"billing_plan": "legacy", "credit_minutes": 0, "welcome_granted": True}
        self.assertEqual(gate_action(row, now=NOW), "start_free")

    def test_free_period_resets_when_elapsed(self):
        open_period = {
            "billing_plan": "free",
            "credit_minutes": 12,
            "plan_period_end": (NOW + timedelta(days=10)).isoformat(),
        }
        elapsed = {
            "billing_plan": "free",
            "credit_minutes": 12,
            "plan_period_end": (NOW - timedelta(days=1)).isoformat(),
        }
        self.assertEqual(gate_action(open_period, now=NOW), "keep")
        self.assertEqual(gate_action(elapsed, now=NOW), "start_free")

    def test_unlimited_skips_minutes_until_period_ends(self):
        active = {
            "billing_plan": "unlimited_monthly",
            "credit_minutes": 0,
            "plan_period_end": (NOW + timedelta(days=5)).isoformat(),
        }
        self.assertTrue(unlimited_is_active(active, now=NOW))
        self.assertEqual(coverage_for_minutes(active, 400, now=NOW)["source"], "unlimited")
        expired_with_prepaid = {
            "billing_plan": "unlimited_annual",
            "credit_minutes": 40,
            "plan_period_end": (NOW - timedelta(hours=1)).isoformat(),
        }
        self.assertEqual(gate_action(expired_with_prepaid, now=NOW), "resume_legacy")
        expired_empty = dict(expired_with_prepaid, credit_minutes=0)
        self.assertEqual(gate_action(expired_empty, now=NOW), "start_free")
        waiting_for_token = dict(expired_empty, unlimited_renew="on")
        self.assertEqual(gate_action(waiting_for_token, now=NOW), "keep")
        self.assertFalse(unlimited_is_active(waiting_for_token, now=NOW))
        past_due = dict(expired_empty, unlimited_renew="past_due")
        self.assertEqual(gate_action(past_due, now=NOW), "start_free")

    def test_pay_per_use_covers_one_short_file_and_asks_for_more_hours(self):
        row = {"billing_plan": "free", "credit_minutes": 0, "pay_use_minutes": 60}
        short = coverage_for_minutes(row, 4, now=NOW)
        self.assertTrue(short["ok"])
        self.assertEqual(short["source"], "pay_use")
        long = coverage_for_minutes(row, 90, now=NOW)
        self.assertFalse(long["ok"])
        self.assertEqual(long["error"], "pay_per_use_short")
        self.assertEqual(long["required_hours"], 2)

    def test_wallet_is_used_before_a_pay_per_use_purchase(self):
        row = {"billing_plan": "legacy", "credit_minutes": 20, "pay_use_minutes": 60}
        self.assertEqual(coverage_for_minutes(row, 10, now=NOW)["source"], "wallet")
        overflow = coverage_for_minutes(row, 40, now=NOW)
        self.assertEqual(overflow["source"], "pay_use")


if __name__ == "__main__":
    unittest.main()
