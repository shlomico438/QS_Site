#!/usr/bin/env python3
"""Export newly registered Supabase users to CSV.

Examples:
  python scripts/export_new_users_csv.py
  python scripts/export_new_users_csv.py --days 14
  python scripts/export_new_users_csv.py --since 2026-07-01 --until 2026-07-15
  python scripts/export_new_users_csv.py --days 14 --only-without-jobs

Reads `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from `.env`.
Outputs a CSV with only `name` and `email` for welcome email campaigns.
"""

from __future__ import annotations

import argparse
import csv
import os
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, Iterable, List

import requests

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

try:
    from dotenv import load_dotenv

    load_dotenv(ROOT / ".env")
except ImportError:
    pass


def _parse_dt(raw: str, *, end_of_day: bool = False) -> datetime:
    text = str(raw or "").strip()
    if not text:
        raise ValueError("empty datetime")
    if len(text) == 10:
        if end_of_day:
            text = text + "T23:59:59+00:00"
        else:
            text = text + "T00:00:00+00:00"
    text = text.replace("Z", "+00:00")
    dt = datetime.fromisoformat(text)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _fmt_dt(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _display_name(user: dict) -> str:
    meta = user.get("user_metadata") if isinstance(user.get("user_metadata"), dict) else {}
    candidates = [
        meta.get("name"),
        " ".join(
            part
            for part in [meta.get("first_name"), meta.get("last_name")]
            if str(part or "").strip()
        ).strip(),
        meta.get("full_name"),
        user.get("email"),
    ]
    for item in candidates:
        val = str(item or "").strip()
        if val:
            return val
    return ""


def _session() -> requests.Session:
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


def _require_env() -> tuple[str, str]:
    url = str(os.environ.get("SUPABASE_URL") or "").rstrip("/")
    key = str(os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    if not url or not key:
        raise SystemExit("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment/.env")
    return url, key


def _admin_headers(service_key: str) -> dict:
    return {
        "Authorization": f"Bearer {service_key}",
        "apikey": service_key,
        "Content-Type": "application/json",
    }


def _list_auth_users(s: requests.Session, supabase_url: str, service_key: str) -> List[dict]:
    users: List[dict] = []
    page = 1
    per_page = 200
    headers = _admin_headers(service_key)
    while True:
        resp = s.get(
            f"{supabase_url}/auth/v1/admin/users",
            headers=headers,
            params={"page": page, "per_page": per_page},
            timeout=30,
        )
        if resp.status_code != 200:
            raise RuntimeError(f"Auth Admin users failed: HTTP {resp.status_code} {resp.text[:300]}")
        payload = resp.json() if resp.text else {}
        batch = payload.get("users") if isinstance(payload, dict) else None
        if not isinstance(batch, list) or not batch:
            break
        users.extend(u for u in batch if isinstance(u, dict))
        if len(batch) < per_page:
            break
        page += 1
    return users


def _chunked(items: Iterable[str], size: int = 100) -> Iterable[List[str]]:
    buf: List[str] = []
    for item in items:
        buf.append(item)
        if len(buf) >= size:
            yield buf
            buf = []
    if buf:
        yield buf


def _rest_headers(service_key: str) -> dict:
    return {
        "Authorization": f"Bearer {service_key}",
        "apikey": service_key,
        "Accept": "application/json",
    }


def _fetch_job_counts(s: requests.Session, supabase_url: str, service_key: str, user_ids: List[str]) -> Dict[str, int]:
    counts: Counter[str] = Counter()
    headers = _rest_headers(service_key)
    for chunk in _chunked(user_ids, size=100):
        in_values = ",".join(f'"{uid}"' for uid in chunk)
        resp = s.get(
            f"{supabase_url}/rest/v1/jobs",
            headers=headers,
            params={"select": "user_id", "user_id": f"in.({in_values})", "limit": 100000},
            timeout=30,
        )
        if resp.status_code != 200:
            raise RuntimeError(f"jobs lookup failed: HTTP {resp.status_code} {resp.text[:300]}")
        rows = resp.json() if resp.text else []
        if not isinstance(rows, list):
            continue
        for row in rows:
            uid = str((row or {}).get("user_id") or "").strip()
            if uid:
                counts[uid] += 1
    return dict(counts)


def _build_output_path(args: argparse.Namespace, since_dt: datetime, until_dt: datetime) -> Path:
    if args.output:
        return Path(args.output).expanduser()
    stamp = f"{since_dt:%Y%m%d}_{until_dt:%Y%m%d}"
    out_dir = ROOT / "exports"
    out_dir.mkdir(parents=True, exist_ok=True)
    suffix = "new_users_no_jobs" if args.only_without_jobs else "new_users"
    return out_dir / f"{suffix}_{stamp}.csv"


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Export newly registered Supabase users to CSV.")
    p.add_argument("--days", type=int, default=14, help="Look back N days from now (default: 14).")
    p.add_argument("--since", help="UTC start, e.g. 2026-07-01 or 2026-07-01T00:00:00Z")
    p.add_argument("--until", help="UTC end, e.g. 2026-07-15 or 2026-07-15T23:59:59Z")
    p.add_argument("--output", help="Output CSV path.")
    p.add_argument(
        "--only-without-jobs",
        action="store_true",
        help="Include only users who have no rows in public.jobs.",
    )
    return p.parse_args()


def main() -> int:
    args = parse_args()
    now = datetime.now(timezone.utc)
    since_dt = _parse_dt(args.since) if args.since else (now - timedelta(days=max(1, int(args.days))))
    until_dt = _parse_dt(args.until, end_of_day=True) if args.until else now
    if since_dt > until_dt:
        raise SystemExit("--since must be earlier than --until")

    supabase_url, service_key = _require_env()
    s = _session()
    all_users = _list_auth_users(s, supabase_url, service_key)

    selected: List[dict] = []
    for user in all_users:
        created_raw = str(user.get("created_at") or "").strip()
        if not created_raw:
            continue
        try:
            created_dt = _parse_dt(created_raw)
        except Exception:
            continue
        if since_dt <= created_dt <= until_dt:
            selected.append(user)

    selected.sort(key=lambda u: str(u.get("created_at") or ""))
    user_ids = [str(u.get("id") or "").strip() for u in selected if str(u.get("id") or "").strip()]
    job_counts = (
        _fetch_job_counts(s, supabase_url, service_key, user_ids)
        if (args.only_without_jobs and user_ids)
        else {}
    )

    rows = []
    for user in selected:
        user_id = str(user.get("id") or "").strip()
        email = str(user.get("email") or "").strip()
        if not email:
            continue
        if args.only_without_jobs and int(job_counts.get(user_id) or 0) > 0:
            continue
        rows.append(
            {
                "name": _display_name(user),
                "email": email,
            }
        )

    out_path = _build_output_path(args, since_dt, until_dt)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=["name", "email"])
        writer.writeheader()
        writer.writerows(rows)

    print(f"Wrote {len(rows)} users to {out_path}")
    print(f"Window: {_fmt_dt(since_dt)} -> {_fmt_dt(until_dt)}")
    if args.only_without_jobs:
        print("Filter: only users without jobs")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
