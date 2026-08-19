from datetime import datetime, timedelta, timezone

from medical_saas import _cardcom_token_info, medical_account_public, medical_entitlement


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


def test_paid_plan_blocks_after_unrenewed_cycle():
    state = medical_entitlement(
        _account(
            subscription_plan="professional",
            subscription_status="active",
            billing_cycle_ends_at=(NOW - timedelta(seconds=1)).isoformat(),
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


def test_trial_account_public_exposes_period_usage():
    public = medical_account_public(_account(current_period_usage_seconds=90 * 60))
    assert public["allowed"] is True
    assert public["subscriptionPlan"] == "trial"
    assert public["usageSeconds"] == 90 * 60
    assert public["usageHours"] == 1.5
    assert public["remainingHours"] == 28.5
