"""Email signup risk scoring: disposable domains + RDAP domain age."""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Dict, Iterable, Optional, Set

import requests

APP_ROOT = Path(__file__).resolve().parent
DEFAULT_BLOCKLIST_PATH = (
    APP_ROOT / "Disposable_email_block_list" / "disposable_email_block_list.txt"
)

TRUSTED_EMAIL_DOMAINS = frozenset(
    {
        "gmail.com",
        "googlemail.com",
        "outlook.com",
        "hotmail.com",
        "live.com",
        "icloud.com",
        "yahoo.com",
        "yahoo.co.il",
        "ymail.com",
        "rocketmail.com",
    }
)

RDAP_URL_TEMPLATE = "https://rdap.org/domain/{domain}"

_disposable_lock = threading.Lock()
_disposable_domains: Optional[Set[str]] = None
_disposable_domains_path: Optional[Path] = None

RdapFetcher = Callable[[str], Optional[int]]


def _normalize_domain(domain: str) -> str:
    return str(domain or "").strip().lower().strip(".")


def extract_email_domain(email: str) -> str:
    """Return lowercase domain from email or empty string if invalid."""
    raw = str(email or "").strip().lower()
    if "@" not in raw:
        return ""
    local, domain = raw.rsplit("@", 1)
    if not local or not domain:
        return ""
    domain = _normalize_domain(domain)
    if not domain or "." not in domain:
        return ""
    if not re.match(r"^[a-z0-9.-]+$", domain):
        return ""
    return domain


def load_disposable_domains(
    path: Optional[os.PathLike | str] = None,
    *,
    force_reload: bool = False,
) -> Set[str]:
    """Load disposable domain blocklist (one domain per line)."""
    global _disposable_domains, _disposable_domains_path
    blocklist_path = Path(path) if path else DEFAULT_BLOCKLIST_PATH
    blocklist_path = blocklist_path.resolve()

    with _disposable_lock:
        if (
            not force_reload
            and _disposable_domains is not None
            and _disposable_domains_path == blocklist_path
        ):
            return set(_disposable_domains)

        domains: Set[str] = set()
        if blocklist_path.is_file():
            with blocklist_path.open("r", encoding="utf-8", errors="ignore") as f:
                for line in f:
                    domain = _normalize_domain(line)
                    if domain:
                        domains.add(domain)
        else:
            logging.warning("email_risk_check: blocklist not found at %s", blocklist_path)

        _disposable_domains = domains
        _disposable_domains_path = blocklist_path
        return set(domains)


def is_disposable_domain(domain: str, *, blocklist: Optional[Iterable[str]] = None) -> bool:
    domain = _normalize_domain(domain)
    if not domain:
        return False
    if blocklist is None:
        blocklist = load_disposable_domains()
    else:
        blocklist = {_normalize_domain(d) for d in blocklist if _normalize_domain(d)}
    return domain in blocklist


def is_trusted_email_domain(domain: str) -> bool:
    return _normalize_domain(domain) in TRUSTED_EMAIL_DOMAINS


def _parse_rdap_registration_date(payload: dict) -> Optional[datetime]:
    events = payload.get("events")
    if not isinstance(events, list):
        return None
    for event in events:
        if not isinstance(event, dict):
            continue
        action = str(event.get("eventAction") or "").strip().lower()
        if action != "registration":
            continue
        raw_date = str(event.get("eventDate") or "").strip()
        if not raw_date:
            continue
        try:
            text = raw_date.replace("Z", "+00:00")
            dt = datetime.fromisoformat(text)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt.astimezone(timezone.utc)
        except ValueError:
            continue
    return None


def fetch_domain_age_days(
    domain: str,
    *,
    session: Optional[requests.Session] = None,
    timeout: float = 8.0,
) -> Optional[int]:
    """Query RDAP for domain registration age in days. None if lookup fails."""
    domain = _normalize_domain(domain)
    if not domain or is_trusted_email_domain(domain):
        return None

    url = RDAP_URL_TEMPLATE.format(domain=domain)
    sess = session or requests.Session()
    try:
        resp = sess.get(url, timeout=timeout, headers={"Accept": "application/rdap+json, application/json"})
        if resp.status_code != 200:
            logging.info(
                "email_risk_check: RDAP HTTP %s for domain=%s",
                resp.status_code,
                domain,
            )
            return None
        payload = resp.json() if resp.text else {}
        if not isinstance(payload, dict):
            return None
        registered_at = _parse_rdap_registration_date(payload)
        if not registered_at:
            logging.info("email_risk_check: RDAP missing registration event domain=%s", domain)
            return None
        age_days = int((datetime.now(timezone.utc) - registered_at).total_seconds() // 86400)
        return max(0, age_days)
    except requests.RequestException as exc:
        logging.info("email_risk_check: RDAP lookup failed domain=%s err=%s", domain, exc)
        return None
    except (json.JSONDecodeError, ValueError, TypeError) as exc:
        logging.info("email_risk_check: RDAP parse failed domain=%s err=%s", domain, exc)
        return None


def _risk_action(score: int) -> str:
    if score >= 100:
        return "block"
    if score >= 70:
        return "verify"
    if score >= 40:
        return "allow_suspicious"
    return "allow"


def assess_email_risk(
    email: str,
    *,
    blocklist: Optional[Iterable[str]] = None,
    rdap_fetcher: Optional[RdapFetcher] = None,
) -> Dict[str, object]:
    """Score signup risk for an email address."""
    domain = extract_email_domain(email)
    reasons: list[str] = []
    score = 0
    disposable = False
    domain_age_days: Optional[int] = None

    if not domain:
        return {
            "score": 0,
            "reasons": [],
            "disposable": False,
            "domainAgeDays": None,
            "domain": "",
            "action": "allow",
            "allowed": True,
        }

    if is_disposable_domain(domain, blocklist=blocklist):
        disposable = True
        score += 100
        reasons.append("disposable_email_domain")

    if not is_trusted_email_domain(domain):
        if rdap_fetcher is not None:
            domain_age_days = rdap_fetcher(domain)
        else:
            domain_age_days = fetch_domain_age_days(domain)

        if domain_age_days is not None:
            if domain_age_days < 180:
                score += 40
                reasons.append("new_domain_less_than_6_months")
            if domain_age_days < 30:
                score += 30
                reasons.append("very_new_domain")

    action = _risk_action(score)
    return {
        "score": score,
        "reasons": reasons,
        "disposable": disposable,
        "domainAgeDays": domain_age_days,
        "domain": domain,
        "action": action,
        "allowed": score < 100,
    }


def log_email_risk_event(
    *,
    email_domain: str,
    risk_score: int,
    reasons: Iterable[str],
    domain_age_days: Optional[int],
    insert_fn: Optional[Callable[..., bool]] = None,
) -> bool:
    """Persist risk event (domain only, no full email). Best-effort."""
    domain = _normalize_domain(email_domain)
    if not domain:
        return False
    if insert_fn is not None:
        return bool(
            insert_fn(
                email_domain=domain,
                risk_score=int(risk_score),
                reasons=list(reasons),
                domain_age_days=domain_age_days,
            )
        )

    supabase_url = (os.environ.get("SUPABASE_URL") or "").rstrip("/")
    service_key = (os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    if not supabase_url or not service_key:
        logging.debug("email_risk_check: skip DB log (Supabase not configured)")
        return False

    payload = {
        "email_domain": domain,
        "risk_score": int(risk_score),
        "reasons": list(reasons),
        "domain_age_days": domain_age_days,
    }
    headers = {
        "Authorization": f"Bearer {service_key}",
        "apikey": service_key,
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    }
    try:
        resp = requests.post(
            f"{supabase_url}/rest/v1/email_risk_events",
            headers=headers,
            json=payload,
            timeout=6,
        )
        if resp.status_code not in (200, 201, 204):
            logging.warning(
                "email_risk_check: log insert failed HTTP %s domain=%s body=%s",
                resp.status_code,
                domain,
                (resp.text or "")[:200],
            )
            return False
        return True
    except requests.RequestException as exc:
        logging.warning("email_risk_check: log insert failed domain=%s err=%s", domain, exc)
        return False
