"""QuickScribe Medical onboarding, entitlement, and usage metering."""

from __future__ import annotations

import logging
import os
import re
import uuid
import hmac
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional, Tuple
from urllib.parse import quote

from flask import jsonify, request


MEDICAL_PLANS: Dict[str, Dict[str, Any]] = {
    "trial": {
        "name": "30-day trial",
        "monthly_price_ils": 0,
        "included_hours": 30,
        "included_seconds": 30 * 3600,
        "seat_limit": 1,
    },
    "starter": {
        "name": "Starter",
        "monthly_price_ils": 149,
        "included_hours": 30,
        "included_seconds": 30 * 3600,
        "seat_limit": 1,
    },
    "professional": {
        "name": "Professional",
        "monthly_price_ils": 249,
        "included_hours": 60,
        "included_seconds": 60 * 3600,
        "seat_limit": 1,
    },
    "clinic": {
        "name": "Clinic",
        "monthly_price_ils": 699,
        "included_hours": 180,
        "included_seconds": 180 * 3600,
        "seat_limit": 5,
    },
}

OVERAGE_ILS_PER_HOUR = 6
QS_MEDICAL_USER_COOKIE = "qs_medical_user"


def attach_medical_user_lock_cookie(resp):
    """Persist doctor product lock so Core `/` and `/en` cannot render the regular app."""
    secure = False
    try:
        xfp = str(request.headers.get("X-Forwarded-Proto") or "").split(",")[0].strip().lower()
        secure = bool(request.is_secure or xfp == "https")
    except Exception:
        pass
    resp.set_cookie(
        QS_MEDICAL_USER_COOKIE,
        "1",
        max_age=34560000,
        path="/",
        samesite="Lax",
        secure=secure,
        httponly=False,
    )
    return resp


def jsonify_medical_account(account, extra=None):
    payload = {
        **medical_account_public(account),
        **(extra or {}),
    }
    resp = jsonify(payload)
    return attach_medical_user_lock_cookie(resp)


def _sa():
    import siteapp

    return siteapp


def _parse_timestamp(raw: Any) -> Optional[datetime]:
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


def _medical_account_get(user_id: str) -> Optional[dict]:
    user_id = str(user_id or "").strip()
    if not user_id:
        return None
    sa = _sa()
    supabase_url, _, headers = sa._supabase_rest_config()
    uid = quote(user_id, safe="")
    r = sa._supabase_http_request(
        "GET",
        f"{supabase_url}/rest/v1/medical_accounts?user_id=eq.{uid}&select=*&limit=1",
        headers=headers,
        timeout=8,
    )
    if r.status_code != 200:
        raise RuntimeError(r.text or f"medical account lookup HTTP {r.status_code}")
    rows = r.json() if r.text else []
    return rows[0] if isinstance(rows, list) and rows else None


def _medical_account_create(user_id: str, full_name: str, specialty: str, email: str = "") -> dict:
    from entitlement_ledger import (
        ledger_mark_medical_payload,
        medical_account_insert_payload,
        normalize_entitlement_email,
    )

    sa = _sa()
    supabase_url, _, headers = sa._supabase_rest_config()
    email_key = normalize_entitlement_email(email)
    ledger = None
    if email_key:
        try:
            ledger = sa._entitlement_ledger_get(email_key)
        except Exception as exc:
            logging.warning("medical ledger lookup failed user=%s: %s", user_id[:8], exc)
    payload = medical_account_insert_payload(
        user_id,
        full_name,
        specialty,
        ledger,
        trial_included_seconds=int(MEDICAL_PLANS["trial"]["included_seconds"]),
        overage_rate_agorot_per_hour=OVERAGE_ILS_PER_HOUR * 100,
    )
    h = dict(headers)
    h["Prefer"] = "resolution=ignore-duplicates,return=representation"
    r = sa._supabase_http_request(
        "POST",
        f"{supabase_url}/rest/v1/medical_accounts?on_conflict=user_id",
        headers=h,
        json=payload,
        timeout=10,
    )
    if r.status_code not in (200, 201):
        raise RuntimeError(r.text or f"medical account create HTTP {r.status_code}")
    rows = r.json() if r.text else []
    account = rows[0] if isinstance(rows, list) and rows else _medical_account_get(user_id)
    if not account:
        raise RuntimeError("medical account was not created")
    if email_key:
        try:
            sa._entitlement_ledger_upsert(ledger_mark_medical_payload(email_key, user_id, account))
        except Exception as exc:
            logging.warning("medical ledger upsert failed user=%s: %s", user_id[:8], exc)
    return account


def _medical_account_update_profile(user_id: str, full_name: str, specialty: str) -> dict:
    sa = _sa()
    supabase_url, _, headers = sa._supabase_rest_config()
    h = dict(headers)
    h["Prefer"] = "return=representation"
    uid = quote(user_id, safe="")
    r = sa._supabase_http_request(
        "PATCH",
        f"{supabase_url}/rest/v1/medical_accounts?user_id=eq.{uid}",
        headers=h,
        json={
            "full_name": full_name,
            "professional_specialty": specialty,
        },
        timeout=10,
    )
    if r.status_code not in (200, 204):
        raise RuntimeError(r.text or f"medical profile update HTTP {r.status_code}")
    rows = r.json() if r.text else []
    return rows[0] if isinstance(rows, list) and rows else (_medical_account_get(user_id) or {})


# Keep access briefly after cycle end so the daily token charge can run first.
MEDICAL_RENEWAL_GRACE = timedelta(hours=36)


def medical_entitlement(account: Optional[dict], now: Optional[datetime] = None) -> dict:
    """Return effective access state; never trusts a client-side plan."""
    now = now or datetime.now(timezone.utc)
    if not account:
        return {
            "allowed": False,
            "reason": "medical_onboarding_required",
            "onboardingRequired": True,
        }

    plan = str(account.get("subscription_plan") or "trial").strip().lower()
    status = str(account.get("subscription_status") or "trialing").strip().lower()
    trial_expires = _parse_timestamp(account.get("trial_expires_at"))
    cycle_ends = _parse_timestamp(account.get("billing_cycle_ends_at"))
    usage = max(0, int(account.get("current_period_usage_seconds") or 0))
    included = max(0, int(account.get("included_seconds") or 0))

    if plan == "trial":
        if status != "trialing" or not trial_expires or now >= trial_expires:
            return {"allowed": False, "reason": "trial_expired", "onboardingRequired": False}
        if usage >= included:
            return {"allowed": False, "reason": "trial_usage_exhausted", "onboardingRequired": False}
        return {"allowed": True, "reason": "trial_active", "onboardingRequired": False}

    if status != "active":
        return {
            "allowed": False,
            "reason": "subscription_" + (status or "inactive"),
            "onboardingRequired": False,
        }
    if not cycle_ends:
        return {"allowed": False, "reason": "billing_cycle_expired", "onboardingRequired": False}
    if now >= cycle_ends + MEDICAL_RENEWAL_GRACE:
        return {"allowed": False, "reason": "billing_cycle_expired", "onboardingRequired": False}
    # Paid plans continue into metered overage after included hours.
    # During the short post-cycle grace window the daily Cardcom cron renews the token.
    return {"allowed": True, "reason": "subscription_active", "onboardingRequired": False}


def _medical_last_billing_failure(user_id: str) -> Optional[str]:
    """Latest failed renewal/Cardcom reason for ops logs (may be None). Not for end-user UI."""
    uid = str(user_id or "").strip()
    if not uid:
        return None
    try:
        sa = _sa()
        supabase_url, _, headers = sa._supabase_rest_config()
        r = sa._supabase_http_request(
            "GET",
            f"{supabase_url}/rest/v1/medical_subscription_payments"
            f"?user_id=eq.{quote(uid, safe='')}"
            f"&status=eq.failed&select=failure_reason,created_at"
            f"&order=created_at.desc&limit=1",
            headers=headers,
            timeout=6,
        )
        if r.status_code != 200:
            return None
        rows = r.json() if r.text else []
        if not isinstance(rows, list) or not rows:
            return None
        reason = str(rows[0].get("failure_reason") or "").strip()
        return reason or None
    except Exception:
        logging.exception("medical last billing failure lookup failed user=%s", uid[:8])
        return None


def _medical_billing_failure_public(raw: Optional[str]) -> Optional[str]:
    """Never expose Cardcom/Shva terminal jargon to the client; ops see the raw reason in logs."""
    if str(raw or "").strip():
        return "payment_failed"
    return None


def medical_account_public(account: dict) -> dict:
    entitlement = medical_entitlement(account)
    plan = str(account.get("subscription_plan") or "trial")
    status = str(account.get("subscription_status") or "")
    usage_seconds = max(0, int(account.get("current_period_usage_seconds") or 0))
    included_seconds = max(0, int(account.get("included_seconds") or 0))
    overage_seconds = max(0, int(account.get("overage_seconds") or 0))
    remaining_seconds = max(0, included_seconds - usage_seconds)
    trial_end = _parse_timestamp(account.get("trial_expires_at"))
    now = datetime.now(timezone.utc)
    trial_days_remaining = (
        max(0, int((trial_end - now).total_seconds() // 86400) + 1)
        if trial_end and plan == "trial"
        else None
    )
    last_failure_public = None
    if status.lower() == "past_due":
        raw_failure = _medical_last_billing_failure(str(account.get("user_id") or ""))
        if raw_failure:
            logging.info(
                "medical past_due billing failure user=%s reason=%s",
                str(account.get("user_id") or "")[:8],
                raw_failure[:300],
            )
        last_failure_public = _medical_billing_failure_public(raw_failure)
    card_last_four = ""
    try:
        billing = _medical_billing_method_get(str(account.get("user_id") or ""))
        card_last_four = "".join(
            ch for ch in str((billing or {}).get("card_last_four") or "") if ch.isdigit()
        )[-4:]
        if len(card_last_four) != 4:
            card_last_four = ""
    except Exception:
        card_last_four = ""
    return {
        **entitlement,
        "isMedicalUser": True,
        "fullName": str(account.get("full_name") or ""),
        "professionalSpecialty": str(account.get("professional_specialty") or ""),
        "subscriptionPlan": plan,
        "subscriptionStatus": status,
        "trialStartedAt": account.get("trial_started_at"),
        "trialExpiresAt": account.get("trial_expires_at"),
        "trialDaysRemaining": trial_days_remaining,
        "billingCycleStartedAt": account.get("billing_cycle_started_at"),
        "billingCycleEndsAt": account.get("billing_cycle_ends_at"),
        "usageSeconds": usage_seconds,
        "usageHours": round(usage_seconds / 3600.0, 2),
        "includedSeconds": included_seconds,
        "includedHours": round(included_seconds / 3600.0, 2),
        "remainingSeconds": remaining_seconds,
        "remainingHours": round(remaining_seconds / 3600.0, 2),
        "overageSeconds": overage_seconds,
        "overageHours": round(overage_seconds / 3600.0, 2),
        "overageAmountIls": round(overage_seconds / 3600.0 * OVERAGE_ILS_PER_HOUR, 2),
        "seatLimit": int(account.get("seat_limit") or 1),
        "lastBillingFailure": last_failure_public,
        "cardLastFour": card_last_four or None,
        "canUpdateCard": plan in MEDICAL_PLANS and plan != "trial",
    }


MEDICAL_PROFESSIONAL_SPECIALTIES = (
    "physician",
    "neurology",
    "orthopedics",
    "psychologist",
    "occupational_therapist",
    "physiotherapist",
    "speech_therapist",
    "nurse",
    "social_worker",
    "other",
)

_PROFESSIONAL_SPECIALTY_ALIASES = {
    "neurologist": "neurology",
    "נוירולוגיה": "neurology",
    "נוירולוג": "neurology",
    "orthopedic": "orthopedics",
    "orthopedist": "orthopedics",
    "orthopaedic": "orthopedics",
    "orthopaedics": "orthopedics",
    "orthopaedist": "orthopedics",
    "אורתופדיה": "orthopedics",
    "אורתופד": "orthopedics",
    "psychology": "psychologist",
    "פסיכולוגיה": "psychologist",
}


def specialty_change_resets_training(previous, new_specialty) -> bool:
    """A real profession change drops the previous personal summary training."""
    previous_raw = str(previous or "").strip()
    new_key = normalize_professional_specialty(new_specialty)
    if not previous_raw or not new_key:
        return False
    return normalize_professional_specialty(previous_raw) != new_key


def normalize_professional_specialty(raw) -> str:
    """Map a profession label to a stored specialty key, or '' if it is not one of the list."""
    key = str(raw or "").strip().lower()
    key = _PROFESSIONAL_SPECIALTY_ALIASES.get(key, key)
    if key not in MEDICAL_PROFESSIONAL_SPECIALTIES:
        return ""
    return key


_DEFAULT_SIGNATURE_MAX_CHARS = 500


def normalize_default_signature(raw) -> str:
    """Store a trimmed standing signature while preserving intentional line breaks."""
    text = str(raw or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    if len(text) > _DEFAULT_SIGNATURE_MAX_CHARS:
        text = text[:_DEFAULT_SIGNATURE_MAX_CHARS].rstrip()
    return text


def _medical_account_set_default_signature(user_id: str, signature: str) -> str:
    """Persist default_signature on the authenticated medical account row."""
    sa = _sa()
    supabase_url, _, headers = sa._supabase_rest_config()
    h = dict(headers)
    h["Prefer"] = "return=representation"
    uid = quote(user_id, safe="")
    stored = normalize_default_signature(signature)
    r = sa._supabase_http_request(
        "PATCH",
        f"{supabase_url}/rest/v1/medical_accounts?user_id=eq.{uid}",
        headers=h,
        json={"default_signature": stored},
        timeout=10,
    )
    if r.status_code not in (200, 204):
        raise RuntimeError(r.text or f"medical default signature update HTTP {r.status_code}")
    rows = r.json() if r.text else []
    if isinstance(rows, list) and rows:
        return normalize_default_signature(rows[0].get("default_signature"))
    return stored


def _medical_account_set_professional_specialty(user_id: str, specialty: str) -> dict:
    """Persist professional_specialty without rewriting the rest of the medical account."""
    sa = _sa()
    supabase_url, _, headers = sa._supabase_rest_config()
    h = dict(headers)
    h["Prefer"] = "return=representation"
    uid = quote(user_id, safe="")
    stored = normalize_professional_specialty(specialty)
    if not stored:
        raise ValueError("Professional specialty is required")
    r = sa._supabase_http_request(
        "PATCH",
        f"{supabase_url}/rest/v1/medical_accounts?user_id=eq.{uid}",
        headers=h,
        json={"professional_specialty": stored},
        timeout=10,
    )
    if r.status_code not in (200, 204):
        raise RuntimeError(r.text or f"medical specialty update HTTP {r.status_code}")
    rows = r.json() if r.text else []
    return rows[0] if isinstance(rows, list) and rows else (_medical_account_get(user_id) or {})


def require_medical_entitlement(req, data: Optional[dict] = None) -> Tuple[Optional[str], Optional[dict], Optional[Tuple[Any, int]]]:
    """Authenticate medical request and enforce onboarding/trial/subscription access."""
    sa = _sa()
    user_id = sa._supabase_user_id_from_request()
    if not user_id:
        return None, None, (jsonify({"error": "medical_auth_required", "message": "Sign in to activate your medical trial."}), 401)
    try:
        account = _medical_account_get(user_id)
        state = medical_entitlement(account)
        if not state.get("allowed"):
            status = 403 if account else 428
            return user_id, account, (
                jsonify(
                    {
                        "error": state.get("reason"),
                        "message": "Your medical trial or subscription is not active.",
                        **state,
                    }
                ),
                status,
            )
        return user_id, account, None
    except Exception as exc:
        logging.exception("medical entitlement lookup failed user=%s", user_id[:8])
        return user_id, None, (jsonify({"error": "medical_entitlement_unavailable", "message": str(exc)}), 503)


def medical_entitlement_for_access_token(access_token: str) -> Tuple[bool, Optional[str], str]:
    """Validate a Supabase token and medical entitlement outside an HTTP bearer route."""
    token = str(access_token or "").strip()
    if not token:
        return False, None, "medical_auth_required"
    try:
        sa = _sa()
        supabase_url, service_key, _ = sa._supabase_rest_config()
        r = sa._supabase_http_request(
            "GET",
            f"{supabase_url}/auth/v1/user",
            headers={
                "Authorization": f"Bearer {token}",
                "apikey": service_key,
            },
            timeout=8,
            retries=1,
        )
        if r.status_code != 200:
            return False, None, "medical_auth_invalid"
        user = r.json() if r.text else {}
        user_id = str((user or {}).get("id") or "").strip()
        if not user_id:
            return False, None, "medical_auth_invalid"
        state = medical_entitlement(_medical_account_get(user_id))
        return bool(state.get("allowed")), user_id, str(state.get("reason") or "medical_access_denied")
    except Exception:
        logging.exception("medical stream token entitlement check failed")
        return False, None, "medical_entitlement_unavailable"


def record_medical_usage(user_id: str, runpod_job_id: str, duration_seconds: float) -> Optional[dict]:
    """Idempotently meter one completed medical job into current_period_usage_seconds.

    Applies to trial and paid plans. The SQL function has no plan gate.
    """
    try:
        seconds = float(duration_seconds or 0)
    except (TypeError, ValueError):
        seconds = 0.0
    if not user_id or not runpod_job_id or seconds <= 0:
        logging.warning(
            "medical usage skipped user=%s job=%s seconds=%s",
            str(user_id or "")[:8],
            runpod_job_id,
            seconds,
        )
        return None
    sa = _sa()
    supabase_url, _, headers = sa._supabase_rest_config()
    h = dict(headers)
    h["Prefer"] = "return=representation"
    r = sa._supabase_http_request(
        "POST",
        f"{supabase_url}/rest/v1/rpc/record_medical_usage",
        headers=h,
        json={
            "p_user_id": user_id,
            "p_runpod_job_id": runpod_job_id,
            "p_duration_seconds": seconds,
        },
        timeout=12,
    )
    if r.status_code not in (200, 201, 204):
        logging.warning(
            "medical usage record failed user=%s job=%s HTTP=%s body=%s",
            user_id[:8],
            runpod_job_id,
            r.status_code,
            (r.text or "")[:300],
        )
        return None
    payload = r.json() if r.text else None
    if isinstance(payload, list):
        return payload[0] if payload else None
    return payload if isinstance(payload, dict) else None


def _medical_payment_get(order_id: str) -> Optional[dict]:
    sa = _sa()
    supabase_url, _, headers = sa._supabase_rest_config()
    r = sa._supabase_http_request(
        "GET",
        f"{supabase_url}/rest/v1/medical_subscription_payments"
        f"?order_id=eq.{quote(order_id, safe='')}&select=*&limit=1",
        headers=headers,
        timeout=8,
    )
    if r.status_code != 200:
        raise RuntimeError(r.text or f"medical payment lookup HTTP {r.status_code}")
    rows = r.json() if r.text else []
    return rows[0] if isinstance(rows, list) and rows else None


_MEDICAL_PAYMENT_OPTIONAL_COLUMNS = frozenset(
    {
        "invoice_number",
        "invoice_type",
        "invoice_url",
        "failure_reason",
        "card_last_four",
    }
)


def _medical_payment_insert(row: dict) -> dict:
    sa = _sa()
    supabase_url, _, headers = sa._supabase_rest_config()
    h = dict(headers)
    h["Prefer"] = "return=representation"
    payload = dict(row or {})
    r = sa._supabase_http_request(
        "POST",
        f"{supabase_url}/rest/v1/medical_subscription_payments",
        headers=h,
        json=payload,
        timeout=10,
    )
    if r.status_code not in (200, 201):
        # Older DBs may lack optional columns (e.g. card_last_four). Retry without them
        # so renewals / card-update follow-ups work without a migration.
        missing_optional = _MEDICAL_PAYMENT_OPTIONAL_COLUMNS.intersection(payload.keys())
        body = r.text or ""
        if missing_optional and (
            r.status_code == 400
            or "PGRST204" in body
            or "card_last_four" in body
            or "schema cache" in body.lower()
        ):
            slim = {k: v for k, v in payload.items() if k not in _MEDICAL_PAYMENT_OPTIONAL_COLUMNS}
            r2 = sa._supabase_http_request(
                "POST",
                f"{supabase_url}/rest/v1/medical_subscription_payments",
                headers=h,
                json=slim,
                timeout=10,
            )
            if r2.status_code in (200, 201):
                logging.warning(
                    "medical payment optional columns missing; inserted without %s",
                    sorted(missing_optional),
                )
                rows = r2.json() if r2.text else []
                return rows[0] if isinstance(rows, list) and rows else slim
        raise RuntimeError(body or f"medical payment insert HTTP {r.status_code}")
    rows = r.json() if r.text else []
    return rows[0] if isinstance(rows, list) and rows else payload


def _medical_payment_update(order_id: str, patch: dict) -> None:
    sa = _sa()
    supabase_url, _, headers = sa._supabase_rest_config()
    r = sa._supabase_http_request(
        "PATCH",
        f"{supabase_url}/rest/v1/medical_subscription_payments"
        f"?order_id=eq.{quote(order_id, safe='')}",
        headers=headers,
        json=patch,
        timeout=10,
    )
    if r.status_code not in (200, 204):
        missing_optional = _MEDICAL_PAYMENT_OPTIONAL_COLUMNS.intersection((patch or {}).keys())
        body = r.text or ""
        if missing_optional and (
            r.status_code == 400
            or "PGRST204" in body
            or "schema cache" in body.lower()
        ):
            slim = {k: v for k, v in (patch or {}).items() if k not in _MEDICAL_PAYMENT_OPTIONAL_COLUMNS}
            if slim:
                r2 = sa._supabase_http_request(
                    "PATCH",
                    f"{supabase_url}/rest/v1/medical_subscription_payments"
                    f"?order_id=eq.{quote(order_id, safe='')}",
                    headers=headers,
                    json=slim,
                    timeout=10,
                )
                if r2.status_code in (200, 204):
                    logging.warning(
                        "medical payment optional columns missing; applied status patch without %s",
                        sorted(missing_optional),
                    )
                    return
        raise RuntimeError(body or f"medical payment update HTTP {r.status_code}")


def _medical_invoice_contact(user_id: str, account: Optional[dict] = None) -> dict:
    sa = _sa()
    account = account if isinstance(account, dict) else (_medical_account_get(user_id) or {})
    email = str(account.get("email") or "").strip()
    name = str(account.get("full_name") or "").strip()
    if (not email or not name) and hasattr(sa, "_supabase_admin_get_user"):
        auth_user = sa._supabase_admin_get_user(user_id)
        if isinstance(auth_user, dict):
            email = email or str(auth_user.get("email") or "").strip()
            if not name and hasattr(sa, "_user_display_name_from_auth_payload"):
                name = str(sa._user_display_name_from_auth_payload(auth_user) or "").strip()
    return {"email": email, "name": name, "external_id": user_id[:64]}


def _medical_notify_paid(payment: dict, extra: Optional[dict] = None) -> None:
    extra = extra if isinstance(extra, dict) else {}
    sa = _sa()
    plan = str(extra.get("plan") or payment.get("plan") or "")
    config = MEDICAL_PLANS.get(plan) or {}
    sa._schedule_admin_payment_notify(
        user_id=str(payment.get("user_id") or ""),
        provider="cardcom",
        product="medical",
        plan=plan,
        payment_kind=str(payment.get("payment_kind") or extra.get("payment_kind") or "initial"),
        amount=extra.get("amount") if extra.get("amount") is not None else payment.get("amount_ils"),
        currency="ILS",
        order_ref=str(payment.get("order_id") or extra.get("order_id") or ""),
        cardcom_transaction_id=str(
            extra.get("cardcom_transaction_id") or payment.get("cardcom_transaction_id") or ""
        ),
        invoice_number=extra.get("invoice_number") or payment.get("invoice_number"),
        invoice_url=extra.get("invoice_url") or payment.get("invoice_url"),
        minutes=int(config.get("included_hours") or 0) * 60,
        skip_capi=True,
    )


def _medical_renewal_for_cycle_end(user_id: str, cycle_end: str) -> Optional[dict]:
    """Latest pending/paid renewal row for this closed billing-cycle end."""
    uid = str(user_id or "").strip()
    end = str(cycle_end or "").strip()
    if not uid or not end:
        return None
    sa = _sa()
    supabase_url, _, headers = sa._supabase_rest_config()
    r = sa._supabase_http_request(
        "GET",
        f"{supabase_url}/rest/v1/medical_subscription_payments"
        f"?user_id=eq.{quote(uid, safe='')}"
        f"&payment_kind=eq.renewal"
        f"&status=in.(pending,paid)"
        f"&billing_cycle_ends_at=eq.{quote(end, safe='')}"
        f"&select=*&order=created_at.desc&limit=1",
        headers=headers,
        timeout=8,
    )
    if r.status_code != 200:
        raise RuntimeError(r.text or f"medical renewal cycle lookup HTTP {r.status_code}")
    rows = r.json() if r.text else []
    return rows[0] if isinstance(rows, list) and rows else None


def _medical_notify_renewal_failed(account: dict, payment: dict, reason: str) -> None:
    """Ops + doctor email when a token renewal fails (e.g. canceled card)."""
    sa = _sa()
    user_id = str((account or {}).get("user_id") or (payment or {}).get("user_id") or "").strip()
    plan = str((payment or {}).get("plan") or (account or {}).get("subscription_plan") or "")
    amount = (payment or {}).get("amount_ils")
    order_id = str((payment or {}).get("order_id") or "").strip()
    last_four = "".join(
        ch for ch in str((payment or {}).get("card_last_four") or "") if ch.isdigit()
    )[-4:]
    if len(last_four) != 4:
        try:
            billing = _medical_billing_method_get(user_id)
            last_four = "".join(
                ch for ch in str((billing or {}).get("card_last_four") or "") if ch.isdigit()
            )[-4:]
        except Exception:
            last_four = ""
    if len(last_four) != 4:
        last_four = ""
    safe_reason = str(reason or "").strip()[:500] or "medical renewal failed"
    # Ops inbox (same channel as successful medical payments).
    try:
        if hasattr(sa, "_schedule_admin_medical_renewal_failure_notify"):
            sa._schedule_admin_medical_renewal_failure_notify(
                user_id=user_id,
                plan=plan,
                amount=amount,
                order_ref=order_id,
                failure_reason=safe_reason,
                card_last_four=last_four or None,
            )
        else:
            logging.warning(
                "medical renewal failure notify helper missing; logging only user=%s reason=%s",
                user_id[:8],
                safe_reason[:200],
            )
    except Exception:
        logging.exception("medical renewal failure ops notify failed user=%s", user_id[:8])
    # Doctor-facing email (no raw Cardcom jargon).
    try:
        contact = _medical_invoice_contact(user_id, account)
        email = str(contact.get("email") or "").strip()
        if not email or not hasattr(sa, "_send_email_via_zoho"):
            return
        name = str(contact.get("name") or "").strip() or "רופא/ה יקר/ה"
        card_line = f" (כרטיס המסתיים ב-{last_four})" if last_four else ""
        subject = "QuickScribe Medical — החיוב החודשי נכשל"
        body = (
            f"שלום {name},\n\n"
            f"ניסינו לחייב את אמצעי התשלום השמור{card_line} עבור חידוש המנוי ל-QuickScribe Medical, "
            "והחיוב לא עבר.\n\n"
            "כדי להחליף כרטיס אשראי, היכנסו ל-\n"
            "https://www.getquickscribe.com/medical\n"
            "פתחו את תפריט הפרופיל ולחצו על «עדכון כרטיס».\n"
            "ניתן להחליף כרטיס גם כשהמנוי פעיל.\n\n"
            "אם הבעיה נמשכת, צרו קשר עם התמיכה.\n\n"
            "QuickScribe Medical\n"
        )
        sa._send_email_via_zoho([email], subject, body, reply_to=None)
    except Exception:
        logging.exception("medical renewal failure doctor email failed user=%s", user_id[:8])


def _medical_issue_invoice_for_payment(order_id: str, billing: dict, email_override: str = "") -> dict:
    from cardcom_payments import (
        _cardcom_issue_standalone_invoice,
        _cardcom_medical_invoice_description,
        _medical_invoices_enabled,
    )

    if not _medical_invoices_enabled():
        raise ValueError("Cardcom invoices are disabled")
    payment = _medical_payment_get(order_id)
    if not payment:
        raise ValueError("Unknown medical payment")
    if str(payment.get("status") or "") != "paid":
        raise ValueError("Payment is not paid yet")
    if str(payment.get("invoice_number") or "").strip():
        return {
            "ok": True,
            "alreadyIssued": True,
            "order_id": order_id,
            "invoice_number": payment.get("invoice_number"),
            "invoice_type": payment.get("invoice_type"),
            "invoice_url": payment.get("invoice_url"),
        }
    user_id = str(payment.get("user_id") or "")
    plan = str(payment.get("plan") or "")
    config = MEDICAL_PLANS.get(plan) or {}
    contact = _medical_invoice_contact(user_id)
    if email_override:
        contact["email"] = str(email_override).strip()
    if not contact.get("email"):
        raise ValueError("Doctor email is required to send the invoice")
    try:
        amount = float(payment.get("amount_ils") or 0)
    except (TypeError, ValueError):
        amount = 0.0
    info = _cardcom_issue_standalone_invoice(
        description=_cardcom_medical_invoice_description(
            plan, int(config.get("included_hours") or 0), True
        ),
        amount_ils=amount,
        contact=contact,
        billing=billing,
        product_id=f"qs-med-{plan}",
        comments=f"order {order_id} txn {payment.get('cardcom_transaction_id') or ''}".strip(),
        tranzaction_id=str(payment.get("cardcom_transaction_id") or ""),
    )
    invoice_patch = {
        k: v
        for k, v in {
            "invoice_number": info.get("invoice_number"),
            "invoice_type": info.get("invoice_type") or "TaxInvoiceAndReceipt",
            "invoice_url": info.get("invoice_url"),
        }.items()
        if v
    }
    if invoice_patch:
        _medical_payment_update(order_id, invoice_patch)
    _medical_notify_paid(payment, {**invoice_patch, "amount": amount, "plan": plan})
    return {"ok": True, "alreadyIssued": False, "order_id": order_id, **invoice_patch}


def _medical_billing_method_upsert(
    user_id: str,
    token_info: dict,
    *,
    preserve_last_four: bool = True,
) -> None:
    sa = _sa()
    supabase_url, _, headers = sa._supabase_rest_config()
    h = dict(headers)
    h["Prefer"] = "resolution=merge-duplicates,return=minimal"
    last_four = "".join(ch for ch in str((token_info or {}).get("last_four") or "") if ch.isdigit())[-4:]
    if len(last_four) != 4 and preserve_last_four:
        # Keep a previously stored last-four when Cardcom omits it on a later token refresh.
        try:
            existing = _medical_billing_method_get(user_id)
            prev = "".join(ch for ch in str((existing or {}).get("card_last_four") or "") if ch.isdigit())[-4:]
            if len(prev) == 4:
                last_four = prev
        except Exception:
            pass
    row = {
        "user_id": user_id,
        "cardcom_token": token_info["token"],
        "card_validity_mmyy": token_info["validity_mmyy"],
        # On an explicit replacement, null is safer than displaying the old card.
        "card_last_four": last_four or None,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    r = sa._supabase_http_request(
        "POST",
        f"{supabase_url}/rest/v1/medical_billing_methods?on_conflict=user_id",
        headers=h,
        json=row,
        timeout=10,
    )
    if r.status_code not in (200, 201, 204):
        raise RuntimeError(r.text or f"medical billing method upsert HTTP {r.status_code}")


def _medical_activate_paid_plan(user_id: str, plan: str) -> dict:
    sa = _sa()
    supabase_url, _, headers = sa._supabase_rest_config()
    h = dict(headers)
    h["Prefer"] = "return=representation"
    r = sa._supabase_http_request(
        "POST",
        f"{supabase_url}/rest/v1/rpc/activate_medical_plan",
        headers=h,
        json={"p_user_id": user_id, "p_plan": plan},
        timeout=12,
    )
    if r.status_code not in (200, 201):
        raise RuntimeError(r.text or f"medical plan activation HTTP {r.status_code}")
    payload = r.json() if r.text else {}
    if isinstance(payload, list):
        return payload[0] if payload else {}
    return payload if isinstance(payload, dict) else {}


def _cardcom_token_info(result: dict) -> Optional[dict]:
    """Extract reusable token + card expiry (MMYY) for later Recurring charges.

    Order matters for bank approval of token charges:
    1. Shva Tokef (printed card MMYY from the acquirer)
    2. CardValidityMonth+Year as a pair (never mix with TokenExDate)
    3. TokenExDate (token lifetime YYYYMMDD) — last resort only; often differs
       from the card (e.g. token 0329 vs card 0229 → issuer decline)
    """
    candidates = [result]
    for key in ("TokenInfo", "TranzactionInfo", "TransactionInfo", "ExtShvaParams"):
        nested = result.get(key) if isinstance(result, dict) else None
        if isinstance(nested, dict):
            candidates.append(nested)

    def first(*keys):
        for obj in candidates:
            for key in keys:
                value = obj.get(key)
                if value not in (None, ""):
                    return str(value).strip()
        return ""

    token = first("Token", "token", "CardToken")
    month_raw = first("CardValidityMonth", "ValidityMonth", "card_validity_month")
    year_raw = first("CardValidityYear", "ValidityYear", "card_validity_year")
    tokef = "".join(
        ch for ch in first("Tokef30", "Tokef_30", "tokef30", "Tokef") if ch.isdigit()
    )
    ex_date = "".join(ch for ch in first("TokenExDate", "token_ex_date") if ch.isdigit())

    card_validity = ""
    if month_raw and year_raw:
        year = year_raw[-2:] if len(year_raw) >= 2 else year_raw
        month = month_raw.zfill(2)[-2:]
        year = year.zfill(2)[-2:]
        card_validity = f"{month}{year}"

    tokef_mmyy = tokef[-4:] if len(tokef) >= 4 else ""
    token_ex_mmyy = ""
    if len(ex_date) >= 6:
        # YYYYMMDD → MMYY
        token_ex_mmyy = f"{ex_date[4:6]}{ex_date[2:4]}"

    if tokef_mmyy:
        validity = tokef_mmyy
        source = "tokef"
        if card_validity and card_validity != tokef_mmyy:
            logging.warning(
                "cardcom card validity %s differs from Shva tokef %s; using tokef for charges",
                card_validity,
                tokef_mmyy,
            )
    elif card_validity:
        validity = card_validity
        source = "card_validity"
    elif token_ex_mmyy:
        validity = token_ex_mmyy
        source = "token_ex_date"
        logging.warning(
            "cardcom token validity falling back to TokenExDate=%s -> MMYY=%s "
            "(may differ from printed card expiry)",
            ex_date,
            validity,
        )
    else:
        validity = ""
        source = "none"

    card_number = first(
        "CardNumber5",
        "CardNumber",
        "Last4Digits",
        "Last4",
        "CardNumEnd",
        "CardNum",
        "card_last_four",
    )
    last_four = "".join(ch for ch in card_number if ch.isdigit())[-4:]
    if len(last_four) != 4:
        last_four = ""
    if not token or len(validity) != 4:
        return None
    logging.info(
        "cardcom token validity source=%s mmyy=%s last4=%s card_validity=%s token_ex=%s",
        source,
        validity,
        last_four or "-",
        card_validity or "-",
        token_ex_mmyy or "-",
    )
    return {"token": token, "validity_mmyy": validity, "last_four": last_four or None}


def _verify_medical_cardcom_payment(
    order_id: str,
    low_profile_id: Optional[str] = None,
    *,
    retry_past_due: bool = False,
) -> dict:
    from cardcom_payments import (
        _cardcom_extract_document_info,
        _cardcom_get_lp_result,
        _simulation_mode,
    )

    payment = _medical_payment_get(order_id)
    if not payment:
        raise ValueError("Unknown medical subscription order")
    if str(payment.get("status") or "") == "paid":
        account = _medical_account_get(str(payment.get("user_id") or ""))
        try:
            amount = float(payment.get("amount_ils") or 0)
        except (TypeError, ValueError):
            amount = 0.0
        paid_kind = str(payment.get("payment_kind") or "initial").strip().lower()
        is_card_update = paid_kind == "card_update" or str(order_id).startswith("qs_med_card_")
        out = {
            "ok": True,
            "alreadyActivated": True,
            "order_id": order_id,
            "amount_ils": amount,
            "currency": "ILS",
            "plan": str(payment.get("plan") or ""),
            **medical_account_public(account or {}),
        }
        if is_card_update:
            out["cardUpdated"] = True
            status_now = str((account or {}).get("subscription_status") or "").strip().lower()
            if retry_past_due and status_now == "past_due":
                try:
                    out["renewal"] = _charge_medical_renewal(
                        account or {},
                        resume_pending=False,
                    )
                except Exception as renew_exc:
                    logging.warning(
                        "medical paid card_update renewal failed user=%s: %s",
                        str(payment.get("user_id") or "")[:8],
                        str(renew_exc)[:200],
                    )
                    out["renewal"] = {
                        "ok": False,
                        "error": str(renew_exc)[:300],
                    }
                refreshed = _medical_account_get(str(payment.get("user_id") or "")) or account or {}
                out.update(medical_account_public(refreshed))
        return out

    if _simulation_mode():
        token_info = {
            "token": f"simulation-{payment['user_id']}",
            "validity_mmyy": "1299",
            "last_four": "0000",
        }
        result = {"ResponseCode": 0, "TranzactionId": "simulation"}
    else:
        lp_id = str(low_profile_id or payment.get("low_profile_id") or "").strip()
        if not lp_id:
            raise ValueError("Missing LowProfileId")
        result = _cardcom_get_lp_result(lp_id)
        response_code = int(result.get("ResponseCode") if result.get("ResponseCode") is not None else -1)
        if response_code != 0:
            _medical_payment_update(order_id, {"status": "failed"})
            raise ValueError(str(result.get("Description") or "Cardcom payment failed"))
        returned_order = str(result.get("ReturnValue") or "").strip()
        if returned_order and returned_order != order_id:
            raise ValueError("Cardcom ReturnValue mismatch")
        token_info = _cardcom_token_info(result)
        if not token_info:
            raise ValueError("Cardcom did not return a reusable billing token")

    user_id = str(payment.get("user_id") or "")
    plan = str(payment.get("plan") or "")
    payment_kind = str(payment.get("payment_kind") or "initial").strip().lower()
    # Prefer payment_kind; also accept qs_med_card_* orders if the DB CHECK
    # constraint does not yet allow payment_kind='card_update'.
    is_card_update = payment_kind == "card_update" or str(order_id).startswith("qs_med_card_")
    _medical_billing_method_upsert(
        user_id,
        token_info,
        preserve_last_four=not is_card_update,
    )
    account = _medical_account_get(user_id) or {}
    if not is_card_update:
        account = _medical_activate_paid_plan(user_id, plan)
    transaction_id = (
        result.get("TranzactionId")
        or (result.get("TranzactionInfo") or {}).get("TranzactionId")
        or ""
    )
    invoice_patch = {}
    if not is_card_update:
        invoice_info = _cardcom_extract_document_info(result) if isinstance(result, dict) else {}
        if invoice_info.get("invoice_error"):
            logging.warning(
                "medical invoice not issued order=%s: %s",
                order_id,
                invoice_info.get("invoice_error"),
            )
        invoice_patch = {
            k: v
            for k, v in {
                "invoice_number": invoice_info.get("invoice_number"),
                "invoice_type": invoice_info.get("invoice_type"),
                "invoice_url": invoice_info.get("invoice_url"),
            }.items()
            if v
        }
    last_four = "".join(ch for ch in str((token_info or {}).get("last_four") or "") if ch.isdigit())[-4:]
    payment_patch = {
        "status": "paid",
        "cardcom_transaction_id": str(transaction_id or ""),
        "paid_at": datetime.now(timezone.utc).isoformat(),
        **invoice_patch,
    }
    if not is_card_update:
        payment_patch["billing_cycle_started_at"] = account.get("billing_cycle_started_at")
        payment_patch["billing_cycle_ends_at"] = account.get("billing_cycle_ends_at")
    if len(last_four) == 4:
        payment_patch["card_last_four"] = last_four
    _medical_payment_update(order_id, payment_patch)
    try:
        amount = float(payment.get("amount_ils") or 0)
    except (TypeError, ValueError):
        amount = 0.0

    renewal_result = None
    if is_card_update:
        # Webhooks only save the token. The authenticated browser confirmation
        # performs the one immediate renewal retry, avoiding webhook/browser races.
        status_now = str((account or {}).get("subscription_status") or "").strip().lower()
        if retry_past_due and status_now == "past_due":
            try:
                renewal_result = _charge_medical_renewal(
                    account,
                    resume_pending=False,
                )
                account = _medical_account_get(user_id) or account
            except Exception as renew_exc:
                logging.warning(
                    "medical card_update saved but renewal still failed user=%s: %s",
                    user_id[:8],
                    str(renew_exc)[:200],
                )
                account = _medical_account_get(user_id) or account
                renewal_result = {
                    "ok": False,
                    "error": str(renew_exc)[:300],
                }
        return {
            "ok": True,
            "cardUpdated": True,
            "alreadyActivated": False,
            "order_id": order_id,
            "amount_ils": amount,
            "currency": "ILS",
            "plan": plan,
            "renewal": renewal_result,
            **medical_account_public(account),
        }

    sa = _sa()
    sa._schedule_meta_capi_purchase(
        user_id=user_id,
        provider="cardcom",
        amount=amount,
        currency="ILS",
        plan=plan,
        order_ref=order_id,
        event_source_url="https://quickscribe.co.il/medical",
    )
    _medical_notify_paid(
        payment,
        {
            "plan": plan,
            "amount": amount,
            "cardcom_transaction_id": str(transaction_id or ""),
            **invoice_patch,
        },
    )
    return {
        "ok": True,
        "alreadyActivated": False,
        "order_id": order_id,
        "amount_ils": amount,
        "currency": "ILS",
        "plan": plan,
        **invoice_patch,
        **medical_account_public(account),
    }


def handle_medical_cardcom_webhook(data: dict) -> bool:
    """Called by the shared Cardcom webhook. Returns True for medical orders."""
    order_id = str((data or {}).get("ReturnValue") or (data or {}).get("return_value") or "").strip()
    if not order_id.startswith("qs_med_"):
        return False
    from cardcom_payments import _cardcom_low_profile_from_mapping

    _verify_medical_cardcom_payment(order_id, _cardcom_low_profile_from_mapping(data) or None)
    return True


def _medical_due_accounts(limit: int = 50) -> list:
    sa = _sa()
    supabase_url, _, headers = sa._supabase_rest_config()
    now = quote(datetime.now(timezone.utc).isoformat(), safe="")
    # Include past_due so a declined charge is retried on the next cron
    # (after ops fixes expiry / card), not only while status stays active.
    r = sa._supabase_http_request(
        "GET",
        f"{supabase_url}/rest/v1/medical_accounts"
        f"?subscription_status=in.(active,past_due)&billing_cycle_ends_at=lte.{now}"
        f"&select=*&order=billing_cycle_ends_at.asc&limit={max(1, min(200, int(limit)))}",
        headers=headers,
        timeout=12,
    )
    if r.status_code != 200:
        raise RuntimeError(r.text or f"medical renewal scan HTTP {r.status_code}")
    rows = r.json() if r.text else []
    return rows if isinstance(rows, list) else []


def _medical_billing_method_get(user_id: str) -> Optional[dict]:
    sa = _sa()
    supabase_url, _, headers = sa._supabase_rest_config()
    r = sa._supabase_http_request(
        "GET",
        f"{supabase_url}/rest/v1/medical_billing_methods"
        f"?user_id=eq.{quote(user_id, safe='')}&select=*&limit=1",
        headers=headers,
        timeout=8,
    )
    if r.status_code != 200:
        raise RuntimeError(r.text or f"medical billing method lookup HTTP {r.status_code}")
    rows = r.json() if r.text else []
    return rows[0] if isinstance(rows, list) and rows else None


def _medical_account_set_status(user_id: str, status: str) -> None:
    sa = _sa()
    supabase_url, _, headers = sa._supabase_rest_config()
    r = sa._supabase_http_request(
        "PATCH",
        f"{supabase_url}/rest/v1/medical_accounts?user_id=eq.{quote(user_id, safe='')}",
        headers=headers,
        json={"subscription_status": status},
        timeout=8,
    )
    if r.status_code not in (200, 204):
        raise RuntimeError(r.text or f"medical account status update HTTP {r.status_code}")


def _medical_timestamps_equal(a, b) -> bool:
    """Compare timestamptz strings loosely (trim / Z vs +00:00)."""
    def _norm(value):
        s = str(value or "").strip()
        if not s:
            return ""
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        return s.replace(" ", "T")
    left, right = _norm(a), _norm(b)
    if left == right:
        return True
    try:
        return _parse_timestamp(left) == _parse_timestamp(right)
    except Exception:
        return False


def _charge_medical_renewal(account: dict, *, resume_pending: bool = True) -> dict:
    from cardcom_payments import _cardcom_api_post, _cardcom_auth_fields, _simulation_mode

    user_id = str(account.get("user_id") or "").strip()
    plan = str(account.get("subscription_plan") or "").strip()
    config = MEDICAL_PLANS.get(plan)
    if not user_id or not config or plan == "trial":
        raise ValueError("Invalid renewal account")
    billing = _medical_billing_method_get(user_id)
    if not billing:
        _medical_account_set_status(user_id, "past_due")
        raise ValueError("No Cardcom billing token")

    # Idempotency is keyed on the period being closed (cycle end), not the new cycle start.
    cycle_start = str(account.get("billing_cycle_started_at") or "")
    cycle_end = str(account.get("billing_cycle_ends_at") or "")
    if not cycle_end:
        raise ValueError("Missing billing_cycle_ends_at")
    base_amount = float(config["monthly_price_ils"])
    overage_seconds = max(0, int(account.get("overage_seconds") or 0))
    overage_amount = round(overage_seconds / 3600.0 * OVERAGE_ILS_PER_HOUR, 2)
    amount_ils = round(base_amount + overage_amount, 2)

    card_last_four = "".join(
        ch for ch in str((billing or {}).get("card_last_four") or "") if ch.isdigit()
    )[-4:]
    if len(card_last_four) != 4:
        card_last_four = ""

    def _insert_pending(order_id: str) -> None:
        row = {
            "user_id": user_id,
            "order_id": order_id,
            "plan": plan,
            "amount_ils": amount_ils,
            "payment_kind": "renewal",
            "status": "pending",
            "billing_cycle_started_at": cycle_start,
            "billing_cycle_ends_at": cycle_end,
        }
        if card_last_four:
            row["card_last_four"] = card_last_four
        _medical_payment_insert(row)

    order_id = f"qs_med_renew_{uuid.uuid4().hex}"
    try:
        _insert_pending(order_id)
    except RuntimeError as exc:
        # Partial unique index: one pending/paid renewal per closed cycle end.
        if "duplicate" not in str(exc).lower() and "23505" not in str(exc):
            raise
        existing = _medical_renewal_for_cycle_end(user_id, cycle_end)
        if not existing:
            return {"ok": True, "skipped": "renewal_already_created", "userId": user_id}
        existing_status = str(existing.get("status") or "").strip().lower()
        # A paid "renewal" that merely describes the *current open* cycle (same start+end
        # as the account) is the previous activation mis-keyed — it must not block the
        # charge that closes this period. Relabel to initial and retry once.
        same_open_cycle = (
            existing_status == "paid"
            and _medical_timestamps_equal(existing.get("billing_cycle_started_at"), cycle_start)
            and _medical_timestamps_equal(existing.get("billing_cycle_ends_at"), cycle_end)
        )
        if same_open_cycle:
            logging.warning(
                "medical renewal: relabeling cycle-opening payment to initial user=%s order=%s",
                user_id[:8],
                str(existing.get("order_id") or "")[:24],
            )
            _medical_payment_update(
                str(existing.get("order_id") or ""),
                {"payment_kind": "initial"},
            )
            order_id = f"qs_med_renew_{uuid.uuid4().hex}"
            _insert_pending(order_id)
        elif existing_status == "pending":
            if not resume_pending:
                return {
                    "ok": True,
                    "skipped": "renewal_in_progress",
                    "userId": user_id,
                    "order_id": existing.get("order_id"),
                }
            order_id = str(existing.get("order_id") or "").strip()
            if not order_id:
                return {"ok": True, "skipped": "renewal_already_created", "userId": user_id}
            logging.info(
                "medical renewal: resuming pending order user=%s order=%s",
                user_id[:8],
                order_id[:24],
            )
        else:
            return {"ok": True, "skipped": "renewal_already_created", "userId": user_id}

    payload = {
        **_cardcom_auth_fields(),
        "Amount": amount_ils,
        "ISOCoinId": 1,
        "Token": billing["cardcom_token"],
        "CardExpirationMMYY": billing["card_validity_mmyy"],
        "IsAutoRecurringPayment": True,
        "TransactionType": "Recurring",
        "ExternalId": order_id,
        "ProductName": f"QuickScribe Medical {config['name']}"[:50],
    }
    from cardcom_payments import (
        _cardcom_build_invoice_document,
        _cardcom_extract_document_info,
        _cardcom_medical_invoice_description,
        _cardcom_resolve_invoice_billing,
        _medical_invoices_enabled,
    )
    if _medical_invoices_enabled():
        try:
            resolved_billing = _cardcom_resolve_invoice_billing(user_id, {})
            contact = _medical_invoice_contact(user_id, account)
            contact["external_id"] = order_id
            payload["Document"] = _cardcom_build_invoice_document(
                product_id=f"qs-med-{plan}",
                description=_cardcom_medical_invoice_description(
                    plan, int(config.get("included_hours") or 0), True
                ),
                amount_ils=amount_ils,
                contact=contact,
                billing=resolved_billing,
                schema="transaction",
            )
        except Exception as inv_exc:
            logging.warning("medical renewal invoice skipped user=%s: %s", user_id[:8], inv_exc)
    try:
        result = (
            {"ResponseCode": 0, "TranzactionId": "simulation-renewal"}
            if _simulation_mode()
            else _cardcom_api_post("Transactions/Transaction", payload)
        )
        response_code = int(result.get("ResponseCode") if result.get("ResponseCode") is not None else -1)
        if response_code != 0:
            desc = str(result.get("Description") or "Cardcom recurring charge failed").strip()
            raise RuntimeError(f"Cardcom {response_code}: {desc}")
        account_after = _medical_activate_paid_plan(user_id, plan)
        transaction_id = (
            result.get("TranzactionId")
            or result.get("TransactionId")
            or result.get("InternalDealNumber")
            or ""
        )
        invoice_info = _cardcom_extract_document_info(result) if isinstance(result, dict) else {}
        invoice_patch = {
            k: v
            for k, v in {
                "invoice_number": invoice_info.get("invoice_number"),
                "invoice_type": invoice_info.get("invoice_type"),
                "invoice_url": invoice_info.get("invoice_url"),
            }.items()
            if v
        }
        # Keep billing_cycle_* as the period that was closed (idempotency key).
        # Do not rewrite them to the new cycle — that blocked the next month.
        _medical_payment_update(
            order_id,
            {
                "status": "paid",
                "cardcom_transaction_id": str(transaction_id),
                "paid_at": datetime.now(timezone.utc).isoformat(),
                "failure_reason": None,
                **invoice_patch,
            },
        )
        sa = _sa()
        sa._schedule_meta_capi_purchase(
            user_id=user_id,
            provider="cardcom",
            amount=amount_ils,
            currency="ILS",
            plan=plan,
            order_ref=order_id,
            event_source_url="https://quickscribe.co.il/medical",
        )
        _medical_notify_paid(
            {
                "user_id": user_id,
                "order_id": order_id,
                "plan": plan,
                "amount_ils": amount_ils,
                "payment_kind": "renewal",
                "cardcom_transaction_id": str(transaction_id),
            },
            invoice_patch,
        )
        return {
            "ok": True,
            "userId": user_id,
            "plan": plan,
            "amountIls": amount_ils,
            "overageAmountIls": overage_amount,
            "billingCycleEndsAt": account_after.get("billing_cycle_ends_at"),
            **invoice_patch,
        }
    except Exception as exc:
        reason = str(exc).strip()[:500] or "medical renewal failed"
        logging.error(
            "medical renewal charge failed user=%s order=%s plan=%s amount=%s reason=%s",
            user_id[:8],
            order_id,
            plan,
            amount_ils,
            reason,
        )
        _medical_payment_update(
            order_id,
            {"status": "failed", "failure_reason": reason},
        )
        _medical_account_set_status(user_id, "past_due")
        try:
            _medical_notify_renewal_failed(
                account,
                {
                    "user_id": user_id,
                    "order_id": order_id,
                    "plan": plan,
                    "amount_ils": amount_ils,
                    "card_last_four": card_last_four or None,
                },
                reason,
            )
        except Exception:
            logging.exception("medical renewal failure notify raised user=%s", user_id[:8])
        raise


MEDICAL_MIC_EVENT_CAUSES = frozenset({
    "no_mic",
    "chrome_block",
    "os_block",
    "busy",
    "hw_mute",
    "dead_device",
    "device_lost",
    "too_quiet",
    "overconstrained",
})
MEDICAL_MIC_EVENT_PHASES = frozenset({"start", "recording"})
MEDICAL_MIC_EVENT_BROWSERS = frozenset({"chrome", "edge", "firefox", "safari", "other"})
MEDICAL_MIC_EVENT_OSES = frozenset({"windows", "mac", "linux", "ios", "android", "other"})
MEDICAL_MIC_EVENT_HOURLY_LIMIT = 30
_MIC_SESSION_ID_RE = re.compile(r"^[A-Za-z0-9-]{8,64}$")


class MedicalMicEventRejected(ValueError):
    """Client payload failed the mic-event allowlist. Nothing is stored."""


def _medical_mic_device_label(raw: Any) -> Optional[str]:
    if raw is None:
        return None
    text = str(raw)
    cleaned = []
    for ch in text:
        if ch.isprintable() and ch not in "\r\n\t":
            cleaned.append(ch)
        else:
            cleaned.append(" ")
    label = " ".join("".join(cleaned).split()).strip()
    if not label:
        return None
    return label[:120]


def medical_mic_event_fields(data: Any) -> Dict[str, Any]:
    """Allowlisted columns only. Caller-supplied user ids are ignored."""
    if not isinstance(data, dict):
        raise MedicalMicEventRejected("invalid_body")
    cause = str(data.get("cause") or "").strip()
    phase = str(data.get("phase") or "").strip()
    browser = str(data.get("browser_family") or "").strip().lower()
    os_family = str(data.get("os_family") or "").strip().lower()
    if cause not in MEDICAL_MIC_EVENT_CAUSES or phase not in MEDICAL_MIC_EVENT_PHASES:
        raise MedicalMicEventRejected("invalid_cause_or_phase")
    if browser not in MEDICAL_MIC_EVENT_BROWSERS or os_family not in MEDICAL_MIC_EVENT_OSES:
        raise MedicalMicEventRejected("invalid_client_family")
    session_raw = data.get("session_id")
    session_id = None
    if session_raw not in (None, ""):
        session_id = str(session_raw).strip()
        if not _MIC_SESSION_ID_RE.fullmatch(session_id):
            raise MedicalMicEventRejected("invalid_session_id")
    return {
        "cause": cause,
        "phase": phase,
        "browser_family": browser,
        "os_family": os_family,
        "device_label": _medical_mic_device_label(data.get("device_label")),
        "session_id": session_id,
    }


def medical_mic_recovery_seconds(data: Any) -> int:
    if not isinstance(data, dict) or "recovery_seconds" not in data:
        raise MedicalMicEventRejected("recovery_seconds_required")
    raw = data.get("recovery_seconds")
    if isinstance(raw, bool) or isinstance(raw, float):
        raise MedicalMicEventRejected("invalid_recovery_seconds")
    try:
        seconds = int(str(raw).strip())
    except (TypeError, ValueError):
        raise MedicalMicEventRejected("invalid_recovery_seconds")
    if seconds < 0 or seconds > 24 * 3600:
        raise MedicalMicEventRejected("invalid_recovery_seconds")
    return seconds


def _medical_mic_event_count_last_hour(user_id: str) -> int:
    sa = _sa()
    supabase_url, _, headers = sa._supabase_rest_config()
    uid = quote(str(user_id), safe="")
    since = quote((datetime.now(timezone.utc) - timedelta(hours=1)).isoformat(), safe="")
    count_headers = dict(headers)
    count_headers["Prefer"] = "count=exact"
    count_headers["Range"] = "0-0"
    response = sa._supabase_http_request(
        "GET",
        (
            f"{supabase_url}/rest/v1/medical_mic_events"
            f"?user_id=eq.{uid}&created_at=gte.{since}&select=id"
        ),
        headers=count_headers,
        timeout=8,
        retries=1,
    )
    if response.status_code not in (200, 206):
        logging.warning("medical mic event count HTTP %s", response.status_code)
        raise RuntimeError("mic event count failed")
    content_range = str(response.headers.get("Content-Range") or "")
    if "/" in content_range:
        total = content_range.rsplit("/", 1)[-1].strip()
        if total.isdigit():
            return int(total)
    rows = response.json() if response.text else []
    return len(rows) if isinstance(rows, list) else 0


def _medical_mic_event_insert(user_id: str, fields: Dict[str, Any]) -> str:
    sa = _sa()
    supabase_url, _, headers = sa._supabase_rest_config()
    payload = {
        "user_id": user_id,
        "cause": fields["cause"],
        "phase": fields["phase"],
        "browser_family": fields["browser_family"],
        "os_family": fields["os_family"],
        "device_label": fields["device_label"],
        "session_id": fields["session_id"],
    }
    insert_headers = dict(headers)
    insert_headers["Prefer"] = "return=representation"
    response = sa._supabase_http_request(
        "POST",
        f"{supabase_url}/rest/v1/medical_mic_events",
        headers=insert_headers,
        json=payload,
        timeout=8,
        retries=1,
    )
    if response.status_code not in (200, 201):
        logging.warning("medical mic event insert HTTP %s", response.status_code)
        raise RuntimeError("mic event insert failed")
    rows = response.json() if response.text else []
    row = rows[0] if isinstance(rows, list) and rows else {}
    event_id = str(row.get("id") or "").strip()
    if not event_id:
        raise RuntimeError("mic event insert returned no id")
    return event_id


def _medical_mic_event_mark_recovered(user_id: str, event_id: str, recovery_seconds: int) -> bool:
    sa = _sa()
    supabase_url, _, headers = sa._supabase_rest_config()
    uid = quote(str(user_id), safe="")
    eid = quote(str(event_id), safe="")
    patch_headers = dict(headers)
    patch_headers["Prefer"] = "return=representation"
    response = sa._supabase_http_request(
        "PATCH",
        (
            f"{supabase_url}/rest/v1/medical_mic_events"
            f"?id=eq.{eid}&user_id=eq.{uid}"
        ),
        headers=patch_headers,
        json={"recovered": True, "recovery_seconds": int(recovery_seconds)},
        timeout=8,
        retries=1,
    )
    if response.status_code not in (200, 204):
        logging.warning("medical mic event recovery HTTP %s", response.status_code)
        raise RuntimeError("mic event recovery failed")
    if response.status_code == 204 or not response.text:
        return False
    rows = response.json() if response.text else []
    return bool(isinstance(rows, list) and rows)


def register_medical_saas_routes(app) -> None:
    @app.route("/api/medical/account", methods=["GET"])
    def api_medical_account_status():
        sa = _sa()
        user_id = sa._supabase_user_id_from_request()
        if not user_id:
            return jsonify({"error": "Authorization required"}), 401
        try:
            account = _medical_account_get(user_id)
            if not account:
                return jsonify(
                    {
                        "allowed": False,
                        "isMedicalUser": False,
                        "onboardingRequired": True,
                        "reason": "medical_onboarding_required",
                        "plans": MEDICAL_PLANS,
                        "overageIlsPerHour": OVERAGE_ILS_PER_HOUR,
                    }
                ), 200
            return jsonify_medical_account(
                account,
                extra={"plans": MEDICAL_PLANS, "overageIlsPerHour": OVERAGE_ILS_PER_HOUR},
            ), 200
        except Exception as exc:
            logging.exception("api_medical_account_status failed")
            return jsonify({"error": str(exc)}), 500

    @app.route("/api/medical/default-signature", methods=["GET"])
    def api_medical_default_signature_get():
        sa = _sa()
        user_id = sa._supabase_user_id_from_request()
        if not user_id:
            return jsonify({"error": "Authorization required"}), 401
        try:
            account = _medical_account_get(user_id) or {}
            signature = normalize_default_signature(account.get("default_signature"))
            return jsonify({"ok": True, "defaultSignature": signature}), 200
        except Exception as exc:
            logging.exception("api_medical_default_signature_get failed")
            return jsonify({"error": str(exc)}), 500

    @app.route("/api/medical/default-signature", methods=["POST", "PUT"])
    def api_medical_default_signature_set():
        sa = _sa()
        user_id = sa._supabase_user_id_from_request()
        if not user_id:
            return jsonify({"error": "Authorization required"}), 401
        data = request.get_json(silent=True) or {}
        raw = data.get("defaultSignature", data.get("default_signature", data.get("signature", "")))
        try:
            account = _medical_account_get(user_id)
            if not account:
                return jsonify({"error": "Medical account required"}), 404
            signature = _medical_account_set_default_signature(user_id, raw)
            return jsonify({"ok": True, "defaultSignature": signature}), 200
        except Exception as exc:
            logging.exception("api_medical_default_signature_set failed")
            return jsonify({"error": str(exc)}), 500

    @app.route("/api/medical/professional-specialty", methods=["POST", "PUT"])
    def api_medical_professional_specialty_set():
        sa = _sa()
        user_id = sa._supabase_user_id_from_request()
        if not user_id:
            return jsonify({"error": "Authorization required"}), 401
        data = request.get_json(silent=True) or {}
        raw = data.get("professionalSpecialty", data.get("professional_specialty", ""))
        specialty = normalize_professional_specialty(raw)
        if not specialty:
            return jsonify({"error": "Professional specialty is required"}), 400
        try:
            account = _medical_account_get(user_id)
            if not account:
                return jsonify({"error": "Medical account required"}), 404
            previous = str(account.get("professional_specialty") or "")
            updated = _medical_account_set_professional_specialty(user_id, specialty)
            training_reset = False
            if specialty_change_resets_training(previous, specialty):
                sa._reset_medical_training_profile(user_id)
                training_reset = True
            return jsonify_medical_account(updated, extra={"trainingReset": training_reset}), 200
        except Exception as exc:
            logging.exception("api_medical_professional_specialty_set failed")
            return jsonify({"error": str(exc)}), 500

    @app.route("/api/medical/activate-trial", methods=["POST"])
    def api_medical_activate_trial():
        sa = _sa()
        auth_user = sa._supabase_auth_user_from_request()
        user_id = str((auth_user or {}).get("id") or "").strip()
        if not user_id:
            return jsonify({"error": "Authorization required"}), 401
        data = request.get_json(silent=True) or {}
        full_name = str(data.get("fullName") or data.get("full_name") or "").strip()
        specialty = str(data.get("professionalSpecialty") or data.get("professional_specialty") or "").strip()
        if len(full_name) < 2:
            return jsonify({"error": "Full name is required"}), 400
        if len(specialty) < 2:
            return jsonify({"error": "Professional specialty is required"}), 400
        try:
            existing = _medical_account_get(user_id)
            account = (
                _medical_account_update_profile(user_id, full_name, specialty)
                if existing
                else _medical_account_create(
                    user_id,
                    full_name,
                    specialty,
                    sa._auth_user_email(auth_user),
                )
            )
            # Never restart an expired/consumed trial through this endpoint.
            return jsonify_medical_account(
                account,
                extra={"plans": MEDICAL_PLANS, "overageIlsPerHour": OVERAGE_ILS_PER_HOUR},
            ), 200
        except Exception as exc:
            logging.exception("api_medical_activate_trial failed")
            return jsonify({"error": str(exc)}), 500

    @app.route("/api/medical/cardcom/create-subscription", methods=["POST"])
    def api_medical_cardcom_create_subscription():
        from cardcom_payments import (
            _cardcom_api_post,
            _cardcom_auth_fields,
            _cardcom_build_invoice_document,
            _cardcom_enabled,
            _cardcom_medical_invoice_description,
            _cardcom_persist_invoice_billing,
            _cardcom_resolve_invoice_billing,
            _simulation_mode,
            _medical_invoices_enabled,
        )

        sa = _sa()
        auth_user = sa._supabase_auth_user_from_request()
        user_id = str((auth_user or {}).get("id") or "").strip()
        if not user_id:
            return jsonify({"error": "Authorization required"}), 401
        simulation = _simulation_mode()
        if not simulation and not _cardcom_enabled():
            return jsonify({"error": "Cardcom payments are not configured"}), 503
        data = request.get_json(silent=True) or {}
        plan = str(data.get("plan") or "").strip().lower()
        config = MEDICAL_PLANS.get(plan)
        if not config or plan == "trial":
            return jsonify({"error": "Unknown medical plan"}), 400
        if not _medical_account_get(user_id):
            return jsonify({"error": "Activate the medical trial before choosing a plan"}), 428

        order_id = f"qs_med_{uuid.uuid4().hex}"
        low_profile_id = str(uuid.uuid4())
        amount_ils = float(config["monthly_price_ils"])
        base = request.url_root.rstrip("/")
        payment = _medical_payment_insert(
            {
                "user_id": user_id,
                "order_id": order_id,
                "low_profile_id": low_profile_id,
                "plan": plan,
                "amount_ils": amount_ils,
                "payment_kind": "initial",
                "status": "pending",
            }
        )
        if simulation:
            return jsonify(
                {
                    "url": f"{base}/medical?medical_cardcom_success=1&medical_order_id={quote(order_id, safe='')}",
                    "orderId": order_id,
                    "simulation": True,
                }
            ), 200

        payload = {
            **_cardcom_auth_fields(),
            "Operation": "ChargeAndCreateToken",
            "ReturnValue": order_id,
            "Amount": amount_ils,
            "ISOCoinId": 1,
            "Language": "he",
            "ProductName": f"QuickScribe Medical {config['name']}"[:50],
            "WebHookUrl": f"{base}/api/cardcom/webhook",
            "SuccessRedirectUrl": (
                f"{base}/medical?medical_cardcom_success=1"
                f"&medical_order_id={quote(order_id, safe='')}"
            ),
            "FailedRedirectUrl": f"{base}/medical?medical_cardcom_cancelled=1",
        }
        if _medical_invoices_enabled():
            invoice_billing = {
                "tax_id": data.get("invoice_tax_id") or data.get("tax_id"),
                "city": data.get("invoice_city") or data.get("city"),
            }
            resolved_billing = _cardcom_resolve_invoice_billing(user_id, invoice_billing)
            try:
                _cardcom_persist_invoice_billing(user_id, resolved_billing)
            except Exception:
                logging.warning("medical invoice billing persist failed user=%s", user_id[:8])
            account = _medical_account_get(user_id) or {}
            contact = _medical_invoice_contact(user_id, account)
            contact["external_id"] = order_id
            try:
                payload["Document"] = _cardcom_build_invoice_document(
                    product_id=f"qs-med-{plan}",
                    description=_cardcom_medical_invoice_description(
                        plan, int(config.get("included_hours") or 0), True
                    ),
                    amount_ils=amount_ils,
                    contact=contact,
                    billing=resolved_billing,
                    schema="lp",
                )
            except ValueError as exc:
                _medical_payment_update(order_id, {"status": "failed"})
                return jsonify({"error": str(exc), "invoice_billing_required": True}), 400
            logging.info("medical invoice document order=%s plan=%s", order_id, plan)
        try:
            result = _cardcom_api_post("LowProfile/Create", payload)
            actual_lp = str(result.get("LowProfileId") or low_profile_id).strip()
            url = str(result.get("Url") or "").strip()
            if not url:
                raise RuntimeError("Cardcom did not return a payment URL")
            if actual_lp != low_profile_id:
                _medical_payment_update(order_id, {"low_profile_id": actual_lp})
            return jsonify(
                {
                    "url": url,
                    "orderId": order_id,
                    "lowProfileId": actual_lp,
                    "simulation": False,
                }
            ), 200
        except Exception as exc:
            _medical_payment_update(order_id, {"status": "failed"})
            logging.exception("medical Cardcom subscription checkout failed")
            return jsonify({"error": str(exc)}), 502

    @app.route("/api/medical/cardcom/update-card", methods=["POST"])
    def api_medical_cardcom_update_card():
        """Replace the saved Cardcom token without changing plan or cycle."""
        from cardcom_payments import (
            _cardcom_api_post,
            _cardcom_auth_fields,
            _cardcom_enabled,
            _simulation_mode,
        )

        order_id = ""
        try:
            sa = _sa()
            auth_user = sa._supabase_auth_user_from_request()
            user_id = str((auth_user or {}).get("id") or "").strip()
            if not user_id:
                return jsonify({"error": "Authorization required"}), 401
            simulation = _simulation_mode()
            if not simulation and not _cardcom_enabled():
                return jsonify({"error": "Cardcom payments are not configured"}), 503

            account = _medical_account_get(user_id)
            if not account:
                return jsonify({"error": "Medical account not found"}), 404
            plan = str(account.get("subscription_plan") or "").strip().lower()
            if plan not in MEDICAL_PLANS or plan == "trial":
                return jsonify({"error": "Choose a paid plan before updating the card"}), 400
            if simulation:
                # A simulated token is not a card update. Requiring Cardcom here
                # prevents the UI from claiming that a card was replaced when the
                # user was never shown a hosted card-entry form.
                return jsonify(
                    {
                        "error": (
                            "Card update requires the Cardcom checkout. "
                            "Set SIMULATION_MODE=false (or CARDCOM_FORCE_LIVE=true) "
                            "and use the configured Cardcom sandbox/live terminal."
                        ),
                        "simulation": True,
                    }
                ), 409

            order_id = f"qs_med_card_{uuid.uuid4().hex}"
            low_profile_id = str(uuid.uuid4())
            # The existing payments schema requires amount_ils > 0, so keep a
            # non-billed bookkeeping value in our pending row. Cardcom receives
            # Amount=0 with J2 validation below and does not charge/reserve ₪1.
            # payment_kind stays 'initial' so no DB CHECK migration is required;
            # qs_med_card_* order ids mark card updates in verify/confirm.
            amount_ils = 1.0
            base = request.url_root.rstrip("/")
            _medical_payment_insert(
                {
                    "user_id": user_id,
                    "order_id": order_id,
                    "low_profile_id": low_profile_id,
                    "plan": plan,
                    "amount_ils": amount_ils,
                    "payment_kind": "initial",
                    "status": "pending",
                }
            )

            payload = {
                **_cardcom_auth_fields(),
                "Operation": "CreateTokenOnly",
                "ReturnValue": order_id,
                "Amount": 0,
                "ISOCoinId": 1,
                "Language": "he",
                "ProductName": "עדכון אמצעי תשלום QuickScribe Medical"[:50],
                "AdvancedDefinition": {
                    # J2 validates the card without an authorization hold.
                    "JValidateType": 2,
                },
                "WebHookUrl": f"{base}/api/cardcom/webhook",
                "SuccessRedirectUrl": (
                    f"{base}/medical?medical_cardcom_success=1"
                    f"&medical_order_id={quote(order_id, safe='')}"
                ),
                "FailedRedirectUrl": f"{base}/medical?medical_cardcom_cancelled=1",
            }
            result = _cardcom_api_post("LowProfile/Create", payload)
            actual_lp = str(result.get("LowProfileId") or low_profile_id).strip()
            url = str(result.get("Url") or "").strip()
            if not url:
                desc = str(result.get("Description") or result.get("ResponseCode") or "").strip()
                raise RuntimeError(desc or "Cardcom did not return a token-update URL")
            if actual_lp != low_profile_id:
                _medical_payment_update(order_id, {"low_profile_id": actual_lp})
            return jsonify(
                {
                    "url": url,
                    "orderId": order_id,
                    "lowProfileId": actual_lp,
                    "simulation": False,
                }
            ), 200
        except Exception as exc:
            if order_id:
                try:
                    _medical_payment_update(order_id, {"status": "failed"})
                except Exception:
                    pass
            logging.exception("medical Cardcom update-card checkout failed")
            return jsonify({"error": str(exc)}), 502

    @app.route("/api/medical/cardcom/issue-invoice", methods=["POST"])
    def api_medical_cardcom_issue_invoice():
        """Ops: issue a Cardcom tax invoice for an already-paid medical order and email the doctor."""
        expected = str(os.environ.get("MEDICAL_BILLING_CRON_SECRET") or "").strip()
        supplied = str(request.headers.get("X-Medical-Billing-Secret") or "").strip()
        if not expected:
            return jsonify({"error": "MEDICAL_BILLING_CRON_SECRET is not configured"}), 503
        if not supplied or not hmac.compare_digest(supplied, expected):
            return jsonify({"error": "Forbidden"}), 403
        data = request.get_json(silent=True) or {}
        order_id = str(data.get("orderId") or data.get("order_id") or "").strip()
        if not order_id:
            return jsonify({"error": "order_id is required"}), 400
        billing = {
            "tax_id": data.get("invoice_tax_id") or data.get("tax_id"),
            "city": data.get("invoice_city") or data.get("city"),
        }
        try:
            result = _medical_issue_invoice_for_payment(
                order_id,
                billing,
                str(data.get("email") or "").strip(),
            )
            return jsonify(result), 200
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        except Exception as exc:
            logging.exception("medical issue-invoice failed order=%s", order_id[:24])
            return jsonify({"error": str(exc)}), 502

    @app.route("/api/medical/cardcom/confirm-subscription", methods=["POST"])
    def api_medical_cardcom_confirm_subscription():
        sa = _sa()
        user_id = sa._supabase_user_id_from_request()
        if not user_id:
            return jsonify({"error": "Authorization required"}), 401
        data = request.get_json(silent=True) or {}
        order_id = str(data.get("orderId") or data.get("order_id") or "").strip()
        payment = _medical_payment_get(order_id) if order_id else None
        if not payment:
            return jsonify({"error": "Unknown order"}), 404
        if str(payment.get("user_id") or "") != user_id:
            return jsonify({"error": "Order does not belong to this user"}), 403
        try:
            return jsonify(
                _verify_medical_cardcom_payment(
                    order_id,
                    retry_past_due=str(order_id).startswith("qs_med_card_"),
                )
            ), 200
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        except Exception as exc:
            logging.exception("medical Cardcom confirmation failed")
            return jsonify({"error": str(exc)}), 500

    @app.route("/api/medical/cardcom/run-renewals", methods=["POST"])
    def api_medical_cardcom_run_renewals():
        """Daily cron target: charge due plans plus accrued overage, then reset cycle."""
        expected = str(os.environ.get("MEDICAL_BILLING_CRON_SECRET") or "").strip()
        supplied = str(
            request.headers.get("X-Medical-Billing-Secret")
            or request.headers.get("X-Billing-Secret")
            or ""
        ).strip()
        if not expected:
            return jsonify({"error": "MEDICAL_BILLING_CRON_SECRET is not configured"}), 503
        if not supplied or not hmac.compare_digest(supplied, expected):
            return jsonify({"error": "Forbidden"}), 403
        data = request.get_json(silent=True) or {}
        limit = int(data.get("limit") or 50)
        results = []
        for account in _medical_due_accounts(limit):
            try:
                results.append(_charge_medical_renewal(account))
            except Exception as exc:
                logging.exception(
                    "medical recurring charge failed user=%s",
                    str(account.get("user_id") or "")[:8],
                )
                results.append(
                    {
                        "ok": False,
                        "userId": str(account.get("user_id") or ""),
                        "error": str(exc),
                    }
                )
        return jsonify(
            {
                "ok": all(row.get("ok") for row in results),
                "processed": len(results),
                "results": results,
            }
        ), 200

    @app.route("/api/medical/mic-event", methods=["POST"])
    def api_medical_mic_event():
        """Record one medical microphone failure. user_id comes from the session."""
        try:
            fields = medical_mic_event_fields(request.get_json(silent=True))
        except MedicalMicEventRejected as exc:
            return jsonify({"error": str(exc)}), 400
        user_id, _account, error_response = require_medical_entitlement(request)
        if error_response:
            return error_response
        try:
            if _medical_mic_event_count_last_hour(user_id) >= MEDICAL_MIC_EVENT_HOURLY_LIMIT:
                return jsonify({"error": "mic_event_rate_limited"}), 429
            event_id = _medical_mic_event_insert(user_id, fields)
        except Exception:
            logging.exception("medical mic event insert failed user=%s", str(user_id)[:8])
            return jsonify({"error": "mic_event_unavailable"}), 503
        logging.info(
            "medical mic event user=%s cause=%s phase=%s",
            str(user_id)[:8],
            fields["cause"],
            fields["phase"],
        )
        return jsonify({"id": event_id}), 201

    @app.route("/api/medical/mic-event/<event_id>/recovered", methods=["POST"])
    def api_medical_mic_event_recovered(event_id):
        """Mark a mic failure recovered. Updates only the current user's row."""
        try:
            uuid.UUID(str(event_id or ""))
            seconds = medical_mic_recovery_seconds(request.get_json(silent=True))
        except (MedicalMicEventRejected, ValueError):
            return jsonify({"error": "invalid_recovery"}), 400
        user_id, _account, error_response = require_medical_entitlement(request)
        if error_response:
            return error_response
        try:
            updated = _medical_mic_event_mark_recovered(user_id, str(event_id), seconds)
        except Exception:
            logging.exception("medical mic event recovery failed user=%s", str(user_id)[:8])
            return jsonify({"error": "mic_event_unavailable"}), 503
        if not updated:
            return jsonify({"error": "not_found"}), 404
        return jsonify({"id": str(event_id)}), 200
