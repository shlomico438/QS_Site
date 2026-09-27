"""Regular (non-medical) plan catalog and coverage rules.

Existing prepaid wallets stay on the legacy balance until it reaches zero.
New accounts use a recurring 30-minute free month. Paid unlimited access
expires with the billing period. Pay-per-use is one file: leftover minutes
from that purchase are dropped after the file, and a file longer than the
purchased hours must be covered by buying more hours.
"""

from datetime import datetime, timedelta, timezone

FREE_MONTHLY_MINUTES = 30
FREE_PERIOD_DAYS = 30
UNLIMITED_MONTHLY_DAYS = 30
UNLIMITED_ANNUAL_DAYS = 365
PAY_PER_USE_MAX_HOURS = 24
PAY_PER_USE_ILS_PER_HOUR = 9
PAY_PER_USE_USD_PER_HOUR = 3

UNLIMITED_PLANS = ("unlimited_monthly", "unlimited_annual")


def clamp_pay_hours(hours):
    try:
        n = int(hours)
    except (TypeError, ValueError):
        n = 1
    return max(1, min(PAY_PER_USE_MAX_HOURS, n))


def hours_for_minutes(minutes):
    """Whole hours needed to cover a file, minimum 1."""
    try:
        minutes = int(minutes or 0)
    except (TypeError, ValueError):
        minutes = 0
    if minutes <= 0:
        return 1
    return max(1, (minutes + 59) // 60)


def resolve_offer(plan_id, hours=1):
    """Return a checkout offer for a new plan id, or None for unknown ids."""
    plan_id = str(plan_id or "").strip().lower()
    hours = clamp_pay_hours(hours)
    if plan_id == "unlimited_monthly":
        return {
            "id": plan_id,
            "name": "QuickScribe Unlimited monthly",
            "plan": plan_id,
            "credit_minutes": 0,
            "hours": 0,
            "amount_ils": 70,
            "amount_usd": 20,
            "period_days": UNLIMITED_MONTHLY_DAYS,
        }
    if plan_id == "unlimited_annual":
        return {
            "id": plan_id,
            "name": "QuickScribe Unlimited annual",
            "plan": plan_id,
            "credit_minutes": 0,
            "hours": 0,
            "amount_ils": 35 * 12,
            "amount_usd": 10 * 12,
            "period_days": UNLIMITED_ANNUAL_DAYS,
        }
    if plan_id == "pay_per_use":
        return {
            "id": plan_id,
            "name": f"QuickScribe pay-per-use ({hours}h)",
            "plan": plan_id,
            "credit_minutes": hours * 60,
            "hours": hours,
            "amount_ils": PAY_PER_USE_ILS_PER_HOUR * hours,
            "amount_usd": PAY_PER_USE_USD_PER_HOUR * hours,
            "period_days": 0,
        }
    return None


def parse_utc(value):
    text = str(value or "").strip()
    if not text:
        return None
    try:
        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def period_end_iso(days, now=None):
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    end = now.astimezone(timezone.utc) + timedelta(days=int(days))
    return end.isoformat().replace("+00:00", "Z")


def unlimited_is_active(row, now=None):
    if not isinstance(row, dict):
        return False
    plan = str(row.get("billing_plan") or "")
    if plan not in UNLIMITED_PLANS:
        return False
    end = parse_utc(row.get("plan_period_end"))
    if not end:
        return False
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    return end > now.astimezone(timezone.utc)


def coverage_for_minutes(row, minutes, now=None):
    """Decide how a file is billed.

    Returns a dict with ok, source (unlimited|wallet|pay_use), and on failure
    error of insufficient_credits or pay_per_use_short plus required_hours.
    """
    try:
        minutes = int(minutes or 0)
    except (TypeError, ValueError):
        minutes = 0
    row = row if isinstance(row, dict) else {}
    if unlimited_is_active(row, now=now):
        return {"ok": True, "source": "unlimited", "credit_minutes": int(row.get("credit_minutes") or 0)}
    balance = int(row.get("credit_minutes") or 0)
    pay_use = int(row.get("pay_use_minutes") or 0)
    if balance >= minutes:
        return {
            "ok": True,
            "source": "wallet",
            "credit_minutes": balance,
            "pay_use_minutes": pay_use,
        }
    if pay_use >= minutes and minutes > 0:
        return {
            "ok": True,
            "source": "pay_use",
            "credit_minutes": balance,
            "pay_use_minutes": pay_use,
        }
    if pay_use > 0:
        return {
            "ok": False,
            "error": "pay_per_use_short",
            "credit_minutes": balance,
            "pay_use_minutes": pay_use,
            "required_minutes": minutes,
            "required_hours": hours_for_minutes(minutes),
        }
    return {
        "ok": False,
        "error": "insufficient_credits",
        "credit_minutes": balance,
        "pay_use_minutes": pay_use,
        "required_minutes": minutes,
    }


def gate_action(row, now=None):
    """What to do to a stored row before a credit check.

    keep: use the row as stored.
    start_free: recurring 30-minute period should begin (legacy wallet is empty,
    free period elapsed, or an unlimited period ended with no leftover minutes).
    resume_legacy: an unlimited period ended and prepaid minutes are still there.
    """
    row = row if isinstance(row, dict) else {}
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    now = now.astimezone(timezone.utc)
    plan = str(row.get("billing_plan") or "")
    balance = int(row.get("credit_minutes") or 0)
    end = parse_utc(row.get("plan_period_end"))
    period_open = bool(end and end > now)

    if plan in UNLIMITED_PLANS:
        if period_open:
            return "keep"
        if balance > 0:
            return "resume_legacy"
        return "start_free"
    if plan == "free":
        if period_open:
            return "keep"
        return "start_free"
    if balance > 0:
        return "keep"
    if row.get("welcome_granted") or plan == "legacy":
        return "start_free"
    return "keep"
