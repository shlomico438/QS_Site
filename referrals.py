"""Referral codes, stored invite emails, and first-purchase bonus minutes."""

from __future__ import annotations

import logging
import os
import re
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from urllib.parse import quote

from entitlement_ledger import normalize_entitlement_email


REFERRAL_REWARD_MINUTES = 60
REFERRAL_PUBLIC_ORIGIN = "https://www.getquickscribe.com"
REFERRAL_CODE_RE = re.compile(r"^[A-Z0-9]{6,12}$")
_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
_CODE_LEN = 8
_CLAIM_MAX_ACCOUNT_AGE = timedelta(days=14)
_LOGGER = logging.getLogger(__name__)


def referral_reward_minutes() -> int:
    raw = (os.environ.get("REFERRAL_REWARD_MINUTES") or "").strip()
    if raw:
        try:
            minutes = int(raw)
            if minutes > 0:
                return minutes
        except (TypeError, ValueError):
            pass
    return REFERRAL_REWARD_MINUTES


def normalize_referral_code(code: Any) -> str:
    return re.sub(r"[^A-Z0-9]", "", str(code or "").strip().upper())


def is_valid_referral_code(code: Any) -> bool:
    return bool(REFERRAL_CODE_RE.fullmatch(normalize_referral_code(code)))


def generate_referral_code() -> str:
    return "".join(secrets.choice(_CODE_ALPHABET) for _ in range(_CODE_LEN))


def referral_link_for_code(code: str, locale: str = "he") -> str:
    clean = normalize_referral_code(code)
    origin = (os.environ.get("REFERRAL_PUBLIC_ORIGIN") or REFERRAL_PUBLIC_ORIGIN).rstrip("/")
    prefix = "/en" if str(locale or "").lower().startswith("en") else ""
    return f"{origin}{prefix}/?ref={clean}"


def public_referral_link(code: str) -> str:
    """Canonical share URL stored in the database (www, Hebrew homepage)."""
    return referral_link_for_code(code, "he")


def build_referral_email(display_name: str, code: str, locale: str = "he") -> dict[str, str]:
    minutes = referral_reward_minutes()
    link = public_referral_link(code)
    name = str(display_name or "").strip() or (
        "A friend" if str(locale or "").lower().startswith("en") else "חבר/ה"
    )
    if str(locale or "").lower().startswith("en"):
        subject = f"{name} invited you to QuickScribe — {minutes} free transcription minutes"
        body = (
            f"Hi,\n\n"
            f"{name} is using QuickScribe for transcription and invited you to try it.\n\n"
            f"Sign up with this link:\n{link}\n\n"
            f"After you buy your first credit pack, you both get {minutes} bonus transcription "
            f"minutes. Credits do not expire.\n\n"
            f"The bonus is added only after a real first purchase — not on signup alone.\n\n"
            f"QuickScribe\nhttps://www.getquickscribe.com\n"
        )
    else:
        subject = f"{name} מזמין/ה אותך ל-QuickScribe — {minutes} דקות תמלול מתנה"
        body = (
            f"שלום,\n\n"
            f"{name} משתמש/ת ב-QuickScribe לתמלול ומזמין/ה אותך לנסות.\n\n"
            f"ההרשמה דרך הקישור הזה:\n{link}\n\n"
            f"אחרי רכישת חבילת הדקות הראשונה, שניכם תקבלו {minutes} דקות תמלול בונוס. "
            f"הדקות לא פגות.\n\n"
            f"הבונוס ניתן רק אחרי רכישה בתשלום ראשונה — לא על הרשמה בלבד.\n\n"
            f"QuickScribe\nhttps://www.getquickscribe.com\n"
        )
    return {"subject": subject, "body": body}


def build_referral_emails(display_name: str, code: str) -> dict[str, dict[str, str]]:
    return {
        "he": build_referral_email(display_name, code, "he"),
        "en": build_referral_email(display_name, code, "en"),
    }


def profile_email_payload(display_name: str, code: str) -> dict[str, str]:
    emails = build_referral_emails(display_name, code)
    return {
        "referral_link": public_referral_link(code),
        "email_subject_he": emails["he"]["subject"],
        "email_body_he": emails["he"]["body"],
        "email_subject_en": emails["en"]["subject"],
        "email_body_en": emails["en"]["body"],
    }


def self_referral_reason(
    *,
    referrer_user_id: str,
    referee_user_id: str,
    referrer_email_key: str = "",
    referee_email_key: str = "",
    referrer_ip: str = "",
    referee_ip: str = "",
) -> Optional[str]:
    referrer_user_id = str(referrer_user_id or "").strip()
    referee_user_id = str(referee_user_id or "").strip()
    if not referrer_user_id or not referee_user_id:
        return "missing_user"
    if referrer_user_id == referee_user_id:
        return "same_account"
    ref_email = normalize_entitlement_email(referrer_email_key) or str(referrer_email_key or "").strip().lower()
    new_email = normalize_entitlement_email(referee_email_key) or str(referee_email_key or "").strip().lower()
    if ref_email and new_email and ref_email == new_email:
        return "same_email"
    ref_ip = str(referrer_ip or "").strip()
    new_ip = str(referee_ip or "").strip()
    if ref_ip and new_ip and ref_ip == new_ip:
        return "same_ip"
    return None


def is_strong_payment_fingerprint(fingerprint: Any) -> bool:
    fp = str(fingerprint or "").strip()
    if not fp:
        return False
    return fp.startswith("stripe:") or ":token:" in fp or ":bin:" in fp


def payment_fingerprint_from_stripe(payment_method: Optional[dict]) -> Optional[str]:
    if not isinstance(payment_method, dict):
        return None
    card = payment_method.get("card") if isinstance(payment_method.get("card"), dict) else {}
    fingerprint = str(card.get("fingerprint") or "").strip()
    if fingerprint:
        return f"stripe:{fingerprint}"
    return None


def payment_fingerprint_from_cardcom(tranz_info: Optional[dict]) -> Optional[str]:
    if not isinstance(tranz_info, dict):
        return None

    def _first(*keys: str) -> str:
        for key in keys:
            val = str(tranz_info.get(key) or "").strip()
            if val:
                return val
        return ""

    token = _first("Token", "CardToken", "CardUniqueId")
    if token and len(token) >= 6:
        return f"cardcom:token:{token}"
    bin6 = "".join(ch for ch in _first("Bin", "CardBin", "First6") if ch.isdigit())[:6]
    last4 = "".join(ch for ch in _first("Last4", "CardNumber5", "CardNumEnd") if ch.isdigit())[-4:]
    if len(bin6) == 6 and len(last4) == 4:
        return f"cardcom:bin:{bin6}:{last4}"
    return None


def account_is_recent_enough(created_at: Any, now: Optional[datetime] = None) -> bool:
    created = _parse_utc(created_at)
    if not created:
        return False
    current = now or datetime.now(timezone.utc)
    if current.tzinfo is None:
        current = current.replace(tzinfo=timezone.utc)
    return (current - created) <= _CLAIM_MAX_ACCOUNT_AGE


def should_grant_first_purchase_reward(
    *,
    attribution: Optional[dict],
    prior_paid_count: int,
    simulation: bool = False,
    fingerprint: str = "",
    fingerprint_owned_by_referrer: bool = False,
) -> tuple[bool, str]:
    if simulation:
        return False, "simulation"
    if not attribution:
        return False, "no_attribution"
    status = str(attribution.get("status") or "").strip().lower()
    if status == "rewarded":
        return False, "already_rewarded"
    if status in ("rejected", "revoked"):
        return False, status
    if status != "pending":
        return False, f"status_{status or 'unknown'}"
    if int(prior_paid_count or 0) > 0:
        return False, "not_first_purchase"
    if fingerprint_owned_by_referrer and is_strong_payment_fingerprint(fingerprint):
        return False, "same_payment_method"
    return True, "ok"


def _parse_utc(value: Any) -> Optional[datetime]:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        if raw.endswith("Z"):
            raw = raw[:-1] + "+00:00"
        dt = datetime.fromisoformat(raw)
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except Exception:
        return None


def _sa():
    import siteapp as sa

    return sa


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def request_client_ip(req=None) -> str:
    if req is None:
        from flask import request as flask_request

        req = flask_request
    raw = ""
    try:
        raw = str(req.headers.get("X-Forwarded-For") or req.remote_addr or "")
    except Exception:
        raw = ""
    return raw.split(",")[0].strip()[:64]


def _rest():
    sa = _sa()
    return sa._supabase_rest_config()


def _get_rows(table: str, query: str) -> list[dict]:
    supabase_url, _key, headers = _rest()
    sa = _sa()
    r = sa._supabase_http_request(
        "GET",
        f"{supabase_url}/rest/v1/{table}?{query}",
        headers=headers,
    )
    if r.status_code == 404 or (
        r.status_code == 400 and table in (r.text or "")
    ):
        _LOGGER.warning("referral table %s unavailable: %s", table, (r.text or "")[:240])
        return []
    if r.status_code != 200:
        raise RuntimeError(r.text or f"Supabase {table} GET HTTP {r.status_code}")
    rows = r.json() if r.text else []
    return rows if isinstance(rows, list) else []


def _insert_row(table: str, row: dict) -> Optional[dict]:
    supabase_url, _key, headers = _rest()
    sa = _sa()
    r = sa._supabase_http_request(
        "POST",
        f"{supabase_url}/rest/v1/{table}",
        headers={**headers, "Prefer": "return=representation"},
        json=row,
    )
    if r.status_code == 409:
        return None
    if r.status_code in (400, 404) and table in (r.text or ""):
        _LOGGER.warning("referral table %s missing: %s", table, (r.text or "")[:240])
        return None
    if r.status_code not in (200, 201):
        raise RuntimeError(r.text or f"Supabase {table} insert HTTP {r.status_code}")
    rows = r.json() if r.text else []
    return rows[0] if rows else row


def _patch_rows(table: str, query: str, patch: dict) -> list[dict]:
    supabase_url, _key, headers = _rest()
    sa = _sa()
    r = sa._supabase_http_request(
        "PATCH",
        f"{supabase_url}/rest/v1/{table}?{query}",
        headers={**headers, "Prefer": "return=representation"},
        json=patch,
    )
    if r.status_code in (400, 404) and table in (r.text or ""):
        return []
    if r.status_code not in (200, 204):
        raise RuntimeError(r.text or f"Supabase {table} patch HTTP {r.status_code}")
    rows = r.json() if r.text else []
    return rows if isinstance(rows, list) else []


def get_profile_by_user(user_id: str) -> Optional[dict]:
    uid = quote(str(user_id or "").strip(), safe="")
    if not uid:
        return None
    rows = _get_rows("referral_profiles", f"user_id=eq.{uid}&select=*&limit=1")
    return rows[0] if rows else None


def get_profile_by_code(code: str) -> Optional[dict]:
    clean = normalize_referral_code(code)
    if not is_valid_referral_code(clean):
        return None
    rows = _get_rows(
        "referral_profiles",
        f"code=eq.{quote(clean, safe='')}&select=*&limit=1",
    )
    return rows[0] if rows else None


def get_attribution(referee_user_id: str) -> Optional[dict]:
    uid = quote(str(referee_user_id or "").strip(), safe="")
    if not uid:
        return None
    rows = _get_rows("referral_attributions", f"referee_user_id=eq.{uid}&select=*&limit=1")
    return rows[0] if rows else None


def count_referrals_for(referrer_user_id: str, status: Optional[str] = None) -> int:
    uid = quote(str(referrer_user_id or "").strip(), safe="")
    if not uid:
        return 0
    query = f"referrer_user_id=eq.{uid}&select=referee_user_id"
    if status:
        query += f"&status=eq.{quote(status, safe='')}"
    return len(_get_rows("referral_attributions", query))


def ensure_profile(user_id: str, display_name: str = "", created_ip: str = "") -> Optional[dict]:
    user_id = str(user_id or "").strip()
    if not user_id:
        return None
    existing = get_profile_by_user(user_id)
    emails = profile_email_payload(display_name, existing["code"] if existing else "PENDING")
    if existing:
        code = str(existing.get("code") or "")
        desired = profile_email_payload(display_name, code)
        needs = any(str(existing.get(key) or "") != desired[key] for key in desired)
        if needs:
            patched = _patch_rows(
                "referral_profiles",
                f"user_id=eq.{quote(user_id, safe='')}",
                desired,
            )
            return patched[0] if patched else {**existing, **desired}
        return existing

    ip = str(created_ip or "").strip() or None
    last_error = None
    for _ in range(8):
        code = generate_referral_code()
        row = {
            "user_id": user_id,
            "code": code,
            **profile_email_payload(display_name, code),
        }
        if ip:
            row["created_ip"] = ip
        try:
            created = _insert_row("referral_profiles", row)
            if created:
                return created
        except RuntimeError as exc:
            last_error = exc
            continue
        raced = get_profile_by_user(user_id)
        if raced:
            return raced
    if last_error:
        raise last_error
    return get_profile_by_user(user_id)


def count_credited_purchases(user_id: str, exclude_order_ref: str = "") -> int:
    uid = quote(str(user_id or "").strip(), safe="")
    if not uid:
        return 0
    exclude = str(exclude_order_ref or "").strip()
    stripe_rows = _get_rows(
        "stripe_credit_purchases",
        f"user_id=eq.{uid}&credited_at=not.is.null&select=stripe_session_id",
    )
    cardcom_rows = _get_rows(
        "cardcom_credit_purchases",
        f"user_id=eq.{uid}&credited_at=not.is.null&select=order_id",
    )
    count = 0
    for row in stripe_rows:
        sid = str(row.get("stripe_session_id") or "").strip()
        if sid and sid != exclude:
            count += 1
    for row in cardcom_rows:
        oid = str(row.get("order_id") or "").strip()
        if oid and oid != exclude:
            count += 1
    return count


def store_payment_fingerprint(user_id: str, fingerprint: str, provider: str = "") -> None:
    user_id = str(user_id or "").strip()
    fingerprint = str(fingerprint or "").strip()
    if not user_id or not fingerprint:
        return
    try:
        _insert_row(
            "referral_payment_fingerprints",
            {
                "user_id": user_id,
                "fingerprint": fingerprint,
                "provider": str(provider or "").strip() or None,
            },
        )
    except Exception as exc:
        _LOGGER.info("referral fingerprint store skipped: %s", exc)


def fingerprint_belongs_to_user(user_id: str, fingerprint: str) -> bool:
    uid = quote(str(user_id or "").strip(), safe="")
    fp = quote(str(fingerprint or "").strip(), safe="")
    if not uid or not fp:
        return False
    rows = _get_rows(
        "referral_payment_fingerprints",
        f"user_id=eq.{uid}&fingerprint=eq.{fp}&select=id&limit=1",
    )
    return bool(rows)


def claim_referral(
    *,
    referee_user_id: str,
    code: str,
    referee_email: str = "",
    referee_created_at: Any = None,
    referee_ip: str = "",
    now: Optional[datetime] = None,
) -> dict[str, Any]:
    referee_user_id = str(referee_user_id or "").strip()
    clean = normalize_referral_code(code)
    if not referee_user_id:
        return {"ok": False, "error": "Authorization required"}
    if not is_valid_referral_code(clean):
        return {"ok": False, "error": "Invalid referral code"}

    existing = get_attribution(referee_user_id)
    if existing:
        return {
            "ok": True,
            "already_attributed": True,
            "status": existing.get("status"),
            "code": existing.get("code"),
        }

    if not account_is_recent_enough(referee_created_at, now=now):
        return {"ok": False, "error": "Referral applies to new accounts only"}

    if count_credited_purchases(referee_user_id) > 0:
        return {"ok": False, "error": "Referral applies before the first purchase"}

    profile = get_profile_by_code(clean)
    if not profile:
        return {"ok": False, "error": "Unknown referral code"}

    referrer_user_id = str(profile.get("user_id") or "").strip()
    sa = _sa()
    referrer_user = sa._supabase_admin_get_user(referrer_user_id) if referrer_user_id else None
    referrer_email = str((referrer_user or {}).get("email") or "").strip()
    reason = self_referral_reason(
        referrer_user_id=referrer_user_id,
        referee_user_id=referee_user_id,
        referrer_email_key=normalize_entitlement_email(referrer_email),
        referee_email_key=normalize_entitlement_email(referee_email),
        referrer_ip=str(profile.get("created_ip") or ""),
        referee_ip=referee_ip,
    )
    status = "rejected" if reason else "pending"
    row = {
        "referee_user_id": referee_user_id,
        "referrer_user_id": referrer_user_id,
        "code": clean,
        "referee_email_key": normalize_entitlement_email(referee_email) or None,
        "referrer_email_key": normalize_entitlement_email(referrer_email) or None,
        "referee_ip": str(referee_ip or "").strip() or None,
        "status": status,
        "reject_reason": reason,
    }
    created = _insert_row("referral_attributions", row)
    if created is None:
        raced = get_attribution(referee_user_id)
        if raced:
            return {
                "ok": True,
                "already_attributed": True,
                "status": raced.get("status"),
                "code": raced.get("code"),
            }
        return {"ok": False, "error": "Could not save referral"}
    if reason:
        return {"ok": False, "error": "Self-referrals are not allowed", "reason": reason}
    return {"ok": True, "status": "pending", "code": clean}


def grant_first_purchase_reward(
    *,
    referee_user_id: str,
    order_ref: str,
    simulation: bool = False,
    fingerprint: str = "",
    provider: str = "",
) -> dict[str, Any]:
    referee_user_id = str(referee_user_id or "").strip()
    order_ref = str(order_ref or "").strip()
    fingerprint = str(fingerprint or "").strip()
    if fingerprint:
        store_payment_fingerprint(referee_user_id, fingerprint, provider)
    attribution = get_attribution(referee_user_id)
    prior = count_credited_purchases(referee_user_id, exclude_order_ref=order_ref)
    owned = bool(
        fingerprint
        and attribution
        and fingerprint_belongs_to_user(str(attribution.get("referrer_user_id") or ""), fingerprint)
    )
    allowed, reason = should_grant_first_purchase_reward(
        attribution=attribution,
        prior_paid_count=prior,
        simulation=simulation,
        fingerprint=fingerprint,
        fingerprint_owned_by_referrer=owned,
    )
    if not allowed:
        if reason == "same_payment_method" and attribution:
            _patch_rows(
                "referral_attributions",
                f"referee_user_id=eq.{quote(referee_user_id, safe='')}&status=eq.pending",
                {
                    "status": "rejected",
                    "reject_reason": reason,
                    "payment_fingerprint": fingerprint or None,
                },
            )
        return {"ok": False, "reason": reason}

    minutes = referral_reward_minutes()
    referrer_id = str(attribution.get("referrer_user_id") or "").strip()
    claimed = _patch_rows(
        "referral_attributions",
        f"referee_user_id=eq.{quote(referee_user_id, safe='')}&status=eq.pending",
        {
            "status": "rewarded",
            "rewarded_at": _utc_now_iso(),
            "reward_order_ref": order_ref,
            "referrer_minutes": minutes,
            "referee_minutes": minutes,
            "payment_fingerprint": fingerprint or None,
        },
    )
    if not claimed:
        return {"ok": False, "reason": "already_rewarded"}

    sa = _sa()
    try:
        sa._user_credits_add_minutes(referrer_id, minutes)
        sa._user_credits_add_minutes(referee_user_id, minutes)
    except Exception:
        _LOGGER.exception(
            "referral credit grant failed referee=%s referrer=%s order=%s",
            referee_user_id[:8],
            referrer_id[:8],
            order_ref,
        )
        _patch_rows(
            "referral_attributions",
            f"referee_user_id=eq.{quote(referee_user_id, safe='')}",
            {"status": "pending", "rewarded_at": None, "reward_order_ref": None},
        )
        raise

    _LOGGER.info(
        "referral rewarded referee=%s referrer=%s minutes=%s order=%s",
        referee_user_id[:8],
        referrer_id[:8],
        minutes,
        order_ref,
    )
    try:
        _notify_referral_reward(referrer_id, referee_user_id, minutes)
    except Exception as exc:
        _LOGGER.warning("referral reward email failed: %s", exc)
    return {
        "ok": True,
        "minutes": minutes,
        "referrer_user_id": referrer_id,
        "referee_user_id": referee_user_id,
    }


def maybe_grant_after_paid_purchase(
    *,
    user_id: str,
    order_ref: str,
    simulation: bool = False,
    fingerprint: str = "",
    provider: str = "",
) -> None:
    try:
        grant_first_purchase_reward(
            referee_user_id=user_id,
            order_ref=order_ref,
            simulation=simulation,
            fingerprint=fingerprint,
            provider=provider,
        )
    except Exception:
        _LOGGER.exception("referral first-purchase hook failed user=%s order=%s", user_id, order_ref)


def _notify_referral_reward(referrer_id: str, referee_id: str, minutes: int) -> None:
    sa = _sa()
    referrer = sa._supabase_admin_get_user(referrer_id) or {}
    referee = sa._supabase_admin_get_user(referee_id) or {}
    ref_email = str(referrer.get("email") or "").strip()
    new_email = str(referee.get("email") or "").strip()
    if ref_email:
        sa._send_email_via_zoho(
            ref_email,
            f"You earned {minutes} referral minutes on QuickScribe",
            (
                f"Someone signed up with your referral link and completed their first purchase.\n\n"
                f"{minutes} bonus transcription minutes were added to your wallet. They do not expire.\n\n"
                f"QuickScribe\n"
            ),
        )
    if new_email:
        sa._send_email_via_zoho(
            new_email,
            f"{minutes} bonus minutes were added to your QuickScribe wallet",
            (
                f"Thanks for your first purchase. Because you used a referral link, "
                f"{minutes} bonus transcription minutes were added on top of your pack. "
                f"They do not expire.\n\n"
                f"QuickScribe\n"
            ),
        )


def profile_public_payload(profile: dict, locale: str = "he") -> dict[str, Any]:
    locale = "en" if str(locale or "").lower().startswith("en") else "he"
    code = str(profile.get("code") or "")
    subject = profile.get(f"email_subject_{locale}") or ""
    body = profile.get(f"email_body_{locale}") or ""
    referrer_id = str(profile.get("user_id") or "")
    return {
        "code": code,
        "link": str(profile.get("referral_link") or public_referral_link(code)),
        "reward_minutes": referral_reward_minutes(),
        "referred_pending": count_referrals_for(referrer_id, "pending"),
        "referred_rewarded": count_referrals_for(referrer_id, "rewarded"),
        "email": {"subject": subject, "body": body, "locale": locale},
        "emails": {
            "he": {
                "subject": profile.get("email_subject_he") or "",
                "body": profile.get("email_body_he") or "",
            },
            "en": {
                "subject": profile.get("email_subject_en") or "",
                "body": profile.get("email_body_en") or "",
            },
        },
    }
