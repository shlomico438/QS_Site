#!/usr/bin/env python3
"""Referral codes, invite emails, and first-purchase reward rules."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest import TestCase

from referrals import (
    REFERRAL_REWARD_MINUTES,
    account_is_recent_enough,
    build_referral_email,
    generate_referral_code,
    is_strong_payment_fingerprint,
    is_valid_referral_code,
    normalize_referral_code,
    payment_fingerprint_from_cardcom,
    payment_fingerprint_from_stripe,
    profile_email_payload,
    public_referral_link,
    self_referral_reason,
    should_grant_first_purchase_reward,
)


NOW = datetime(2026, 9, 13, 12, 0, tzinfo=timezone.utc)


class ReferralCodeTests(TestCase):
    def test_normalize_and_validate(self):
        self.assertEqual(normalize_referral_code(" qs-7k2m "), "QS7K2M")
        self.assertTrue(is_valid_referral_code("AB23CD45"))
        self.assertFalse(is_valid_referral_code("***"))
        self.assertFalse(is_valid_referral_code("abc"))

    def test_generated_codes_are_valid(self):
        for _ in range(20):
            code = generate_referral_code()
            self.assertTrue(is_valid_referral_code(code))
            self.assertEqual(len(code), 8)


class ReferralEmailTests(TestCase):
    def test_hebrew_and_english_include_link_and_minutes(self):
        he = build_referral_email("דנה", "AB23CD45", "he")
        en = build_referral_email("Dana", "AB23CD45", "en")
        link = public_referral_link("AB23CD45")
        self.assertIn("getquickscribe.com/?ref=AB23CD45", link)
        self.assertIn(link, he["body"])
        self.assertIn(link, en["body"])
        self.assertIn(str(REFERRAL_REWARD_MINUTES), he["body"])
        self.assertIn(str(REFERRAL_REWARD_MINUTES), en["body"])
        self.assertTrue(he["subject"])
        self.assertTrue(en["subject"])

    def test_profile_payload_has_both_locales(self):
        row = profile_email_payload("Dana", "AB23CD45")
        self.assertEqual(row["referral_link"], public_referral_link("AB23CD45"))
        self.assertIn("AB23CD45", row["email_body_he"])
        self.assertIn("AB23CD45", row["email_body_en"])


class SelfReferralTests(TestCase):
    def test_same_account_and_email(self):
        self.assertEqual(
            self_referral_reason(
                referrer_user_id="u1",
                referee_user_id="u1",
                referrer_email_key="a@x.com",
                referee_email_key="b@x.com",
            ),
            "same_account",
        )
        self.assertEqual(
            self_referral_reason(
                referrer_user_id="u1",
                referee_user_id="u2",
                referrer_email_key="dana+1@gmail.com",
                referee_email_key="d.ana@gmail.com",
            ),
            "same_email",
        )

    def test_same_ip(self):
        self.assertEqual(
            self_referral_reason(
                referrer_user_id="u1",
                referee_user_id="u2",
                referrer_email_key="a@x.com",
                referee_email_key="b@x.com",
                referrer_ip="1.2.3.4",
                referee_ip="1.2.3.4",
            ),
            "same_ip",
        )

    def test_distinct_users_ok(self):
        self.assertIsNone(
            self_referral_reason(
                referrer_user_id="u1",
                referee_user_id="u2",
                referrer_email_key="a@x.com",
                referee_email_key="b@x.com",
                referrer_ip="1.1.1.1",
                referee_ip="8.8.8.8",
            )
        )


class FirstPurchaseRuleTests(TestCase):
    def test_only_pending_first_paid_purchase(self):
        pending = {"status": "pending"}
        ok, reason = should_grant_first_purchase_reward(
            attribution=pending, prior_paid_count=0
        )
        self.assertTrue(ok)
        self.assertEqual(reason, "ok")
        self.assertEqual(
            should_grant_first_purchase_reward(attribution=pending, prior_paid_count=1)[1],
            "not_first_purchase",
        )
        self.assertEqual(
            should_grant_first_purchase_reward(
                attribution=pending, prior_paid_count=0, simulation=True
            )[1],
            "simulation",
        )
        self.assertEqual(
            should_grant_first_purchase_reward(
                attribution={"status": "rewarded"}, prior_paid_count=0
            )[1],
            "already_rewarded",
        )

    def test_same_strong_payment_method_blocked(self):
        ok, reason = should_grant_first_purchase_reward(
            attribution={"status": "pending"},
            prior_paid_count=0,
            fingerprint="stripe:fp_abc",
            fingerprint_owned_by_referrer=True,
        )
        self.assertFalse(ok)
        self.assertEqual(reason, "same_payment_method")

    def test_weak_last4_is_not_enough_to_block(self):
        self.assertFalse(is_strong_payment_fingerprint("cardcom:last4:1234"))
        ok, _reason = should_grant_first_purchase_reward(
            attribution={"status": "pending"},
            prior_paid_count=0,
            fingerprint="cardcom:last4:1234",
            fingerprint_owned_by_referrer=True,
        )
        self.assertTrue(ok)


class FingerprintParseTests(TestCase):
    def test_stripe_and_cardcom(self):
        self.assertEqual(
            payment_fingerprint_from_stripe({"card": {"fingerprint": "xyz"}}),
            "stripe:xyz",
        )
        self.assertEqual(
            payment_fingerprint_from_cardcom({"Token": "tok_123456", "Last4": "4580"}),
            "cardcom:token:tok_123456",
        )
        self.assertEqual(
            payment_fingerprint_from_cardcom({"Bin": "458000", "Last4": "0000"}),
            "cardcom:bin:458000:0000",
        )
        self.assertIsNone(payment_fingerprint_from_cardcom({"Last4": "0000"}))


class AccountAgeTests(TestCase):
    def test_recent_accounts_only(self):
        self.assertTrue(account_is_recent_enough(NOW.isoformat(), now=NOW))
        old = (NOW - timedelta(days=20)).isoformat()
        self.assertFalse(account_is_recent_enough(old, now=NOW))


if __name__ == "__main__":
    from unittest import main

    main()
