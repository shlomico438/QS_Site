from datetime import datetime, timedelta, timezone

from medical_saas import (
    _cardcom_token_info,
    _medical_timestamps_equal,
    medical_account_public,
    medical_entitlement,
    normalize_default_signature,
)


NOW = datetime(2026, 7, 28, 10, 0, tzinfo=timezone.utc)


def _account(**overrides):
    row = {
        "subscription_plan": "trial",
        "subscription_status": "trialing",
        "trial_expires_at": (NOW + timedelta(days=10)).isoformat(),
        "billing_cycle_ends_at": (NOW + timedelta(days=10)).isoformat(),
        "included_seconds": 30 * 3600,
        "current_period_usage_seconds": 0,
    }
    row.update(overrides)
    return row


def test_medical_account_requires_onboarding():
    state = medical_entitlement(None, NOW)
    assert state["allowed"] is False
    assert state["onboardingRequired"] is True


def test_active_trial_is_allowed():
    state = medical_entitlement(_account(), NOW)
    assert state["allowed"] is True
    assert state["reason"] == "trial_active"


def test_expired_trial_is_blocked():
    state = medical_entitlement(
        _account(trial_expires_at=(NOW - timedelta(seconds=1)).isoformat()),
        NOW,
    )
    assert state["allowed"] is False
    assert state["reason"] == "trial_expired"


def test_trial_stops_at_thirty_hours():
    state = medical_entitlement(
        _account(current_period_usage_seconds=30 * 3600),
        NOW,
    )
    assert state["allowed"] is False
    assert state["reason"] == "trial_usage_exhausted"


def test_paid_plan_allows_metered_overage():
    state = medical_entitlement(
        _account(
            subscription_plan="starter",
            subscription_status="active",
            current_period_usage_seconds=31 * 3600,
        ),
        NOW,
    )
    assert state["allowed"] is True
    assert state["reason"] == "subscription_active"


def test_paid_plan_stays_allowed_during_renewal_grace():
    """Cycle end alone must not lock the doctor before the daily token charge runs."""
    state = medical_entitlement(
        _account(
            subscription_plan="professional",
            subscription_status="active",
            billing_cycle_ends_at=(NOW - timedelta(hours=1)).isoformat(),
        ),
        NOW,
    )
    assert state["allowed"] is True
    assert state["reason"] == "subscription_active"


def test_paid_plan_blocks_after_unrenewed_grace():
    state = medical_entitlement(
        _account(
            subscription_plan="professional",
            subscription_status="active",
            billing_cycle_ends_at=(NOW - timedelta(hours=37)).isoformat(),
        ),
        NOW,
    )
    assert state["allowed"] is False
    assert state["reason"] == "billing_cycle_expired"


def test_cardcom_token_fields_are_normalized():
    token = _cardcom_token_info(
        {
            "TokenInfo": {
                "Token": "token-id",
                "CardValidityMonth": "7",
                "CardValidityYear": "2029",
                "CardNumEnd": "1234",
            }
        }
    )
    assert token == {
        "token": "token-id",
        "validity_mmyy": "0729",
        "last_four": "1234",
    }


def test_cardcom_token_prefers_tokef_over_card_validity_and_token_ex():
    token = _cardcom_token_info(
        {
            "Token": "token-id",
            "CardValidityMonth": "03",
            "CardValidityYear": "2029",
            "TokenExDate": "20290301",
            "ExtShvaParams": {"Tokef_30": "0229", "CardNumber5": "9876"},
        }
    )
    assert token["validity_mmyy"] == "0229"
    assert token["last_four"] == "9876"


def test_cardcom_token_uses_card_validity_before_token_ex_date():
    token = _cardcom_token_info(
        {
            "Token": "token-id",
            "CardValidityMonth": "02",
            "CardValidityYear": "2029",
            "TokenExDate": "20290301",
        }
    )
    assert token["validity_mmyy"] == "0229"


def test_cardcom_token_does_not_mix_card_year_with_token_ex_month():
    # Old bug: year from CardValidity + month from TokenExDate → wrong MMYY.
    token = _cardcom_token_info(
        {
            "Token": "token-id",
            "CardValidityYear": "2029",
            "TokenExDate": "20290301",
        }
    )
    assert token["validity_mmyy"] == "0329"  # full TokenExDate fallback only


def test_trial_account_public_exposes_period_usage():
    public = medical_account_public(_account(current_period_usage_seconds=90 * 60))
    assert public["allowed"] is True
    assert public["isMedicalUser"] is True
    assert public["subscriptionPlan"] == "trial"
    assert public["usageSeconds"] == 90 * 60
    assert public["usageHours"] == 1.5
    assert public["remainingHours"] == 28.5


def test_expired_trial_still_flags_medical_user():
    public = medical_account_public(
        _account(trial_expires_at=(NOW - timedelta(seconds=1)).isoformat())
    )
    assert public["allowed"] is False
    assert public["isMedicalUser"] is True
    assert public["onboardingRequired"] is False


def test_normalize_default_signature_preserves_line_breaks():
    assert normalize_default_signature("  ד\"ר כהן  ") == "ד\"ר כהן"
    assert normalize_default_signature("בברכה,\r\nד\"ר כהן") == "בברכה,\nד\"ר כהן"
    assert normalize_default_signature(None) == ""
    assert len(normalize_default_signature("א" * 800)) == 500


def test_medical_invoice_description_is_hebrew():
    from cardcom_payments import _cardcom_medical_invoice_description

    text = _cardcom_medical_invoice_description("starter", 30, True)
    assert "Starter" in text
    assert "30" in text
    assert "QuickScribe Medical" in text


def test_medical_timestamps_equal_tolerates_format():
    assert _medical_timestamps_equal(
        "2026-11-12 11:42:25.850066+00",
        "2026-11-12T11:42:25.850066+00:00",
    )
    assert not _medical_timestamps_equal(
        "2026-11-12 11:42:25.850066+00",
        "2026-11-13 11:42:25.850066+00",
    )
