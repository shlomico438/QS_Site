"""Durable per-email entitlements that survive Auth user deletion.

Welcome minutes and the medical trial are granted once per normalized email,
not per auth.users id. Returning users restore leftover credits / leftover
trial instead of receiving a fresh pack.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Optional


GMAIL_DOMAINS = frozenset({"gmail.com", "googlemail.com"})


def normalize_entitlement_email(email: str) -> str:
    """Canonical email key for the entitlement ledger.

    - lowercase, trim
    - googlemail.com → gmail.com
    - strip +tags (all providers)
    - Gmail: ignore dots in the local part
    """
    raw = str(email or "").strip().lower()
    if "@" not in raw:
        return ""
    local, domain = raw.rsplit("@", 1)
    local = local.strip()
    domain = domain.strip().strip(".")
    if not local or not domain or "." not in domain:
        return ""
    if domain == "googlemail.com":
        domain = "gmail.com"
    if "+" in local:
        local = local.split("+", 1)[0].strip()
    if domain in GMAIL_DOMAINS or domain == "gmail.com":
        local = local.replace(".", "")
    if not local:
        return ""
    return f"{local}@{domain}"


def welcome_minutes_for_ledger(ledger: Optional[dict], default_minutes: int = 60) -> int:
    """Minutes to put on a brand-new auth user.

    First time: default welcome pack.
    Already welcomed: leftover snapshot only (0 if they used it or deleted
    without a snapshot).
    """
    default_minutes = max(0, int(default_minutes or 0))
    if not ledger or not ledger.get("welcome_granted"):
        return default_minutes
    snap = ledger.get("credit_minutes_snapshot")
    if snap is None or snap == "":
        return 0
    try:
        return max(0, int(snap))
    except (TypeError, ValueError):
        return 0


def is_returning_welcome(ledger: Optional[dict]) -> bool:
    return bool(ledger and ledger.get("welcome_granted"))


def _parse_ts(raw: Any) -> Optional[datetime]:
    text = str(raw or "").strip()
    if not text:
        return None
    try:
        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except (TypeError, ValueError):
        return None


def _iso(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def medical_account_insert_payload(
    user_id: str,
    full_name: str,
    specialty: str,
    ledger: Optional[dict],
    *,
    now: Optional[datetime] = None,
    trial_included_seconds: int = 30 * 3600,
    overage_rate_agorot_per_hour: int = 600,
) -> dict:
    """Build medical_accounts insert. Returning emails do not get a fresh trial."""
    now = now or datetime.now(timezone.utc)
    payload = {
        "user_id": user_id,
        "full_name": full_name,
        "professional_specialty": specialty,
        "subscription_plan": "trial",
        "subscription_status": "trialing",
        "included_seconds": int(trial_included_seconds),
        "seat_limit": 1,
        "overage_rate_agorot_per_hour": int(overage_rate_agorot_per_hour),
        "current_period_usage_seconds": 0,
        "overage_seconds": 0,
    }
    if not ledger or not ledger.get("medical_trial_used"):
        return payload

    plan = str(ledger.get("medical_subscription_plan") or "trial").strip().lower() or "trial"
    status = str(ledger.get("medical_subscription_status") or "").strip().lower()
    usage = max(0, int(ledger.get("medical_usage_seconds") or 0))
    included = max(0, int(ledger.get("medical_included_seconds") or trial_included_seconds))
    expires = _parse_ts(ledger.get("medical_trial_expires_at"))
    cycle_end = _parse_ts(ledger.get("medical_billing_cycle_ends_at"))
    cycle_start = _parse_ts(ledger.get("medical_billing_cycle_started_at"))
    started = _parse_ts(ledger.get("medical_trial_started_at"))

    if plan in ("starter", "professional", "clinic") and status == "active":
        payload.update(
            {
                "subscription_plan": plan,
                "subscription_status": "active",
                "included_seconds": included,
                "current_period_usage_seconds": usage,
                "trial_started_at": _iso(started or now),
                "trial_expires_at": _iso(expires or now),
            }
        )
        if cycle_start:
            payload["billing_cycle_started_at"] = _iso(cycle_start)
        if cycle_end:
            payload["billing_cycle_ends_at"] = _iso(cycle_end)
        return payload

    leftover_trial = (
        plan == "trial"
        and status == "trialing"
        and expires is not None
        and expires > now
        and usage < included
    )
    if leftover_trial:
        payload.update(
            {
                "subscription_plan": "trial",
                "subscription_status": "trialing",
                "included_seconds": included,
                "current_period_usage_seconds": usage,
                "trial_started_at": _iso(started or now),
                "trial_expires_at": _iso(expires),
            }
        )
        return payload

    payload.update(
        {
            "subscription_plan": "trial",
            "subscription_status": "expired",
            "included_seconds": included,
            "current_period_usage_seconds": max(usage, included),
            "trial_started_at": _iso(started or now),
            "trial_expires_at": _iso(expires if expires and expires <= now else (now - timedelta(seconds=1))),
        }
    )
    return payload


def ledger_mark_welcome_payload(email_key: str, user_id: str, minutes_granted: int, is_restore: bool) -> dict:
    now = _iso(datetime.now(timezone.utc))
    payload = {
        "email_key": email_key,
        "last_user_id": user_id,
        "welcome_granted": True,
        "updated_at": now,
    }
    if not is_restore:
        payload["welcome_minutes_granted"] = max(0, int(minutes_granted or 0))
    return payload


def ledger_delete_snapshot_payload(
    email_key: str,
    user_id: str,
    wallet: Optional[dict],
    medical_account: Optional[dict],
    *,
    now: Optional[datetime] = None,
) -> dict:
    now = now or datetime.now(timezone.utc)
    payload = {
        "email_key": email_key,
        "last_user_id": user_id,
        "last_deleted_at": _iso(now),
        "updated_at": _iso(now),
        "credit_minutes_snapshot": max(0, int((wallet or {}).get("credit_minutes") or 0)),
    }
    if wallet and wallet.get("welcome_granted"):
        payload["welcome_granted"] = True
    if medical_account:
        payload.update(
            {
                "medical_trial_used": True,
                "medical_trial_started_at": medical_account.get("trial_started_at"),
                "medical_trial_expires_at": medical_account.get("trial_expires_at"),
                "medical_usage_seconds": int(medical_account.get("current_period_usage_seconds") or 0),
                "medical_included_seconds": int(medical_account.get("included_seconds") or 0),
                "medical_subscription_plan": medical_account.get("subscription_plan"),
                "medical_subscription_status": medical_account.get("subscription_status"),
                "medical_billing_cycle_started_at": medical_account.get("billing_cycle_started_at"),
                "medical_billing_cycle_ends_at": medical_account.get("billing_cycle_ends_at"),
            }
        )
    return {k: v for k, v in payload.items() if v is not None}


def ledger_mark_medical_payload(email_key: str, user_id: str, account: dict) -> dict:
    now = _iso(datetime.now(timezone.utc))
    return {
        "email_key": email_key,
        "last_user_id": user_id,
        "medical_trial_used": True,
        "medical_trial_started_at": account.get("trial_started_at"),
        "medical_trial_expires_at": account.get("trial_expires_at"),
        "medical_usage_seconds": int(account.get("current_period_usage_seconds") or 0),
        "medical_included_seconds": int(account.get("included_seconds") or 0),
        "medical_subscription_plan": account.get("subscription_plan"),
        "medical_subscription_status": account.get("subscription_status"),
        "medical_billing_cycle_started_at": account.get("billing_cycle_started_at"),
        "medical_billing_cycle_ends_at": account.get("billing_cycle_ends_at"),
        "updated_at": now,
    }
