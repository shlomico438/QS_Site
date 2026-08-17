"""QuickScribe Medical onboarding, entitlement, and usage metering."""

from __future__ import annotations

import logging
import os
import uuid
import hmac
from datetime import datetime, timezone
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


def _medical_account_create(user_id: str, full_name: str, specialty: str) -> dict:
    sa = _sa()
    supabase_url, _, headers = sa._supabase_rest_config()
    payload = {
        "user_id": user_id,
        "full_name": full_name,
        "professional_specialty": specialty,
        "subscription_plan": "trial",
        "subscription_status": "trialing",
        "included_seconds": MEDICAL_PLANS["trial"]["included_seconds"],
        "seat_limit": 1,
        "overage_rate_agorot_per_hour": OVERAGE_ILS_PER_HOUR * 100,
    }
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
    if isinstance(rows, list) and rows:
        return rows[0]
    existing = _medical_account_get(user_id)
    if not existing:
        raise RuntimeError("medical account was not created")
    return existing


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
    if not cycle_ends or now >= cycle_ends:
        return {"allowed": False, "reason": "billing_cycle_expired", "onboardingRequired": False}
    # Paid plans continue into metered overage after included hours.
    return {"allowed": True, "reason": "subscription_active", "onboardingRequired": False}


def medical_account_public(account: dict) -> dict:
    entitlement = medical_entitlement(account)
    plan = str(account.get("subscription_plan") or "trial")
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
    return {
        **entitlement,
        "fullName": str(account.get("full_name") or ""),
        "professionalSpecialty": str(account.get("professional_specialty") or ""),
        "subscriptionPlan": plan,
        "subscriptionStatus": str(account.get("subscription_status") or ""),
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
    }


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
    """Idempotently meter one completed medical job through the DB function."""
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


def _medical_payment_insert(row: dict) -> dict:
    sa = _sa()
    supabase_url, _, headers = sa._supabase_rest_config()
    h = dict(headers)
    h["Prefer"] = "return=representation"
    r = sa._supabase_http_request(
        "POST",
        f"{supabase_url}/rest/v1/medical_subscription_payments",
        headers=h,
        json=row,
        timeout=10,
    )
    if r.status_code not in (200, 201):
        raise RuntimeError(r.text or f"medical payment insert HTTP {r.status_code}")
    rows = r.json() if r.text else []
    return rows[0] if isinstance(rows, list) and rows else row


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
        raise RuntimeError(r.text or f"medical payment update HTTP {r.status_code}")


def _medical_billing_method_upsert(user_id: str, token_info: dict) -> None:
    sa = _sa()
    supabase_url, _, headers = sa._supabase_rest_config()
    h = dict(headers)
    h["Prefer"] = "resolution=merge-duplicates,return=minimal"
    r = sa._supabase_http_request(
        "POST",
        f"{supabase_url}/rest/v1/medical_billing_methods?on_conflict=user_id",
        headers=h,
        json={
            "user_id": user_id,
            "cardcom_token": token_info["token"],
            "card_validity_mmyy": token_info["validity_mmyy"],
            "card_last_four": token_info.get("last_four"),
            "updated_at": datetime.now(timezone.utc).isoformat(),
        },
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

    token = first("Token", "token")
    month = first("CardValidityMonth", "ValidityMonth", "card_validity_month")
    year = first("CardValidityYear", "ValidityYear", "card_validity_year")
    ex_date = first("TokenExDate", "token_ex_date")
    if not month and len(ex_date) >= 6:
        month = ex_date[4:6]
    if not year and len(ex_date) >= 4:
        year = ex_date[:4]
    if len(year) == 4:
        year = year[-2:]
    month = month.zfill(2)[-2:] if month else ""
    validity = f"{month}{year}" if month and year else ""
    card_number = first("CardNumber5", "Last4", "CardNumEnd", "card_last_four")
    last_four = "".join(ch for ch in card_number if ch.isdigit())[-4:]
    if not token or len(validity) != 4:
        return None
    return {"token": token, "validity_mmyy": validity, "last_four": last_four or None}


def _verify_medical_cardcom_payment(order_id: str, low_profile_id: Optional[str] = None) -> dict:
    from cardcom_payments import (
        _cardcom_get_lp_result,
        _cardcom_low_profile_from_mapping,
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
        return {
            "ok": True,
            "alreadyActivated": True,
            "order_id": order_id,
            "amount_ils": amount,
            "currency": "ILS",
            "plan": str(payment.get("plan") or ""),
            **medical_account_public(account or {}),
        }

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
    _medical_billing_method_upsert(user_id, token_info)
    account = _medical_activate_paid_plan(user_id, plan)
    transaction_id = (
        result.get("TranzactionId")
        or (result.get("TranzactionInfo") or {}).get("TranzactionId")
        or ""
    )
    _medical_payment_update(
        order_id,
        {
            "status": "paid",
            "cardcom_transaction_id": str(transaction_id or ""),
            "paid_at": datetime.now(timezone.utc).isoformat(),
            "billing_cycle_started_at": account.get("billing_cycle_started_at"),
            "billing_cycle_ends_at": account.get("billing_cycle_ends_at"),
        },
    )
    try:
        amount = float(payment.get("amount_ils") or 0)
    except (TypeError, ValueError):
        amount = 0.0
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
    return {
        "ok": True,
        "alreadyActivated": False,
        "order_id": order_id,
        "amount_ils": amount,
        "currency": "ILS",
        "plan": plan,
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
    r = sa._supabase_http_request(
        "GET",
        f"{supabase_url}/rest/v1/medical_accounts"
        f"?subscription_status=eq.active&billing_cycle_ends_at=lte.{now}"
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


def _charge_medical_renewal(account: dict) -> dict:
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

    cycle_start = str(account.get("billing_cycle_started_at") or "")
    cycle_end = str(account.get("billing_cycle_ends_at") or "")
    base_amount = float(config["monthly_price_ils"])
    overage_seconds = max(0, int(account.get("overage_seconds") or 0))
    overage_amount = round(overage_seconds / 3600.0 * OVERAGE_ILS_PER_HOUR, 2)
    amount_ils = round(base_amount + overage_amount, 2)
    order_id = f"qs_med_renew_{uuid.uuid4().hex}"
    try:
        _medical_payment_insert(
            {
                "user_id": user_id,
                "order_id": order_id,
                "plan": plan,
                "amount_ils": amount_ils,
                "payment_kind": "renewal",
                "status": "pending",
                "billing_cycle_started_at": cycle_start,
                "billing_cycle_ends_at": cycle_end,
            }
        )
    except RuntimeError as exc:
        # The partial unique index makes a billing cycle idempotent across cron retries.
        if "duplicate" in str(exc).lower() or "23505" in str(exc):
            return {"ok": True, "skipped": "renewal_already_created", "userId": user_id}
        raise

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
    try:
        result = (
            {"ResponseCode": 0, "TranzactionId": "simulation-renewal"}
            if _simulation_mode()
            else _cardcom_api_post("Transactions/Transaction", payload)
        )
        response_code = int(result.get("ResponseCode") if result.get("ResponseCode") is not None else -1)
        if response_code != 0:
            raise RuntimeError(str(result.get("Description") or "Cardcom recurring charge failed"))
        account_after = _medical_activate_paid_plan(user_id, plan)
        transaction_id = (
            result.get("TranzactionId")
            or result.get("TransactionId")
            or result.get("InternalDealNumber")
            or ""
        )
        _medical_payment_update(
            order_id,
            {
                "status": "paid",
                "cardcom_transaction_id": str(transaction_id),
                "paid_at": datetime.now(timezone.utc).isoformat(),
                "billing_cycle_started_at": account_after.get("billing_cycle_started_at"),
                "billing_cycle_ends_at": account_after.get("billing_cycle_ends_at"),
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
        return {
            "ok": True,
            "userId": user_id,
            "plan": plan,
            "amountIls": amount_ils,
            "overageAmountIls": overage_amount,
        }
    except Exception:
        _medical_payment_update(order_id, {"status": "failed"})
        _medical_account_set_status(user_id, "past_due")
        raise


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
                        "onboardingRequired": True,
                        "reason": "medical_onboarding_required",
                        "plans": MEDICAL_PLANS,
                        "overageIlsPerHour": OVERAGE_ILS_PER_HOUR,
                    }
                ), 200
            return jsonify(
                {
                    **medical_account_public(account),
                    "plans": MEDICAL_PLANS,
                    "overageIlsPerHour": OVERAGE_ILS_PER_HOUR,
                }
            ), 200
        except Exception as exc:
            logging.exception("api_medical_account_status failed")
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
                else _medical_account_create(user_id, full_name, specialty)
            )
            # Never restart an expired/consumed trial through this endpoint.
            return jsonify(
                {
                    **medical_account_public(account),
                    "plans": MEDICAL_PLANS,
                    "overageIlsPerHour": OVERAGE_ILS_PER_HOUR,
                }
            ), 200
        except Exception as exc:
            logging.exception("api_medical_activate_trial failed")
            return jsonify({"error": str(exc)}), 500

    @app.route("/api/medical/cardcom/create-subscription", methods=["POST"])
    def api_medical_cardcom_create_subscription():
        from cardcom_payments import (
            _cardcom_api_post,
            _cardcom_auth_fields,
            _cardcom_enabled,
            _simulation_mode,
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
            return jsonify(_verify_medical_cardcom_payment(order_id)), 200
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        except Exception as exc:
            logging.exception("medical Cardcom confirmation failed")
            return jsonify({"error": str(exc)}), 500

    @app.route("/api/medical/cardcom/run-renewals", methods=["POST"])
    def api_medical_cardcom_run_renewals():
        """Daily cron target: charge due plans plus accrued overage, then reset cycle."""
        expected = str(os.environ.get("MEDICAL_BILLING_CRON_SECRET") or "").strip()
        supplied = str(request.headers.get("X-Medical-Billing-Secret") or "").strip()
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
