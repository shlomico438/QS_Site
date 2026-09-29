import unittest
from unittest.mock import patch

import cardcom_payments as cc


class RegularCardcomRecurringTests(unittest.TestCase):
    def setUp(self):
        self._billing_db = cc._regular_billing_db
        self._renewal_db = cc._regular_renewal_db
        cc._regular_billing_memory.clear()
        cc._regular_renewal_memory.clear()
        cc._regular_billing_db = False
        cc._regular_renewal_db = False

    def tearDown(self):
        cc._regular_billing_memory.clear()
        cc._regular_renewal_memory.clear()
        cc._regular_billing_db = self._billing_db
        cc._regular_renewal_db = self._renewal_db

    def test_unlimited_creates_a_token_and_other_plans_charge_once(self):
        self.assertEqual(cc.cardcom_low_profile_operation("unlimited_monthly"), "ChargeAndCreateToken")
        self.assertEqual(cc.cardcom_low_profile_operation("unlimited_annual"), "ChargeAndCreateToken")
        self.assertEqual(cc.cardcom_low_profile_operation("pay_per_use"), "ChargeOnly")
        self.assertEqual(cc.cardcom_low_profile_operation("standard"), "ChargeOnly")

    def test_invoice_line_names_the_unlimited_plan(self):
        monthly = {"plan": "unlimited_monthly", "credit_minutes": 0}
        annual = {"plan": "unlimited_annual", "credit_minutes": 0}
        hours = {"plan": "pay_per_use", "hours": 2, "credit_minutes": 120}
        self.assertIn("חודשי", cc._cardcom_invoice_line_description(monthly, True))
        self.assertIn("annual", cc._cardcom_invoice_line_description(annual, False))
        self.assertIn("2", cc._cardcom_invoice_line_description(hours, False))

    def _due_row(self, **extra):
        row = {
            "user_id": "user-1",
            "billing_plan": "unlimited_monthly",
            "unlimited_renew": "on",
            "plan_period_end": "2026-09-01T00:00:00Z",
        }
        row.update(extra)
        return row

    def test_renewal_charges_the_token_once(self):
        cc._regular_billing_memory["user-1"] = {
            "user_id": "user-1",
            "cardcom_token": "tok-1",
            "card_validity_mmyy": "1299",
        }
        extended = []
        with patch.object(cc, "_simulation_mode", return_value=True), \
             patch.object(cc, "_extend_regular_unlimited", side_effect=lambda user_id, plan: extended.append((user_id, plan))), \
             patch.object(cc, "_notify_regular_renewal", return_value=None):
            first = cc._charge_regular_renewal(self._due_row())
            second = cc._charge_regular_renewal(self._due_row())
        self.assertTrue(first["ok"])
        self.assertEqual(first["amount_ils"], 70)
        self.assertEqual(extended, [("user-1", "unlimited_monthly")])
        self.assertEqual(second.get("skipped"), "already_renewed")
        saved = cc._regular_renewal_get("user-1", "2026-09-01T00:00:00Z")
        self.assertEqual(saved["status"], "paid")

    def test_missing_token_marks_past_due_without_extending(self):
        marked = []
        with patch.object(cc, "_simulation_mode", return_value=True), \
             patch.object(cc, "_extend_regular_unlimited", side_effect=AssertionError("should not extend")), \
             patch.object(cc, "_set_regular_renew_status", side_effect=lambda user_id, status: marked.append((user_id, status))):
            with self.assertRaises(ValueError):
                cc._charge_regular_renewal(self._due_row())
        self.assertEqual(marked, [("user-1", "past_due")])
        saved = cc._regular_renewal_get("user-1", "2026-09-01T00:00:00Z")
        self.assertEqual(saved["status"], "failed")

    def test_declined_token_charge_does_not_extend(self):
        cc._regular_billing_memory["user-1"] = {
            "cardcom_token": "tok-1",
            "card_validity_mmyy": "1299",
        }
        marked = []
        with patch.object(cc, "_simulation_mode", return_value=False), \
             patch.object(cc, "_cardcom_invoices_enabled", return_value=False), \
             patch.object(cc, "_cardcom_api_post", return_value={"ResponseCode": 6, "Description": "declined"}), \
             patch.object(cc, "_extend_regular_unlimited", side_effect=AssertionError("should not extend")), \
             patch.object(cc, "_set_regular_renew_status", side_effect=lambda user_id, status: marked.append(status)):
            with self.assertRaises(RuntimeError):
                cc._charge_regular_renewal(self._due_row())
        self.assertEqual(marked, ["past_due"])

    def test_cancelled_plan_is_not_charged(self):
        with patch.object(cc, "_extend_regular_unlimited", side_effect=AssertionError("should not extend")):
            result = cc._charge_regular_renewal(self._due_row(unlimited_renew="off"))
        self.assertEqual(result.get("skipped"), "renew_off")


if __name__ == "__main__":
    unittest.main()
