#!/usr/bin/env python3
"""Export users with exactly 60 credit minutes to a UTF-8 CSV (Excel-safe).

Examples:
  python scripts/export_users_with_60_credits_csv.py
  python scripts/export_users_with_60_credits_csv.py --output exports/credits_60.csv

Reads `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from `.env`.
Writes CSV with columns: username, email
Uses utf-8-sig so Hebrew names open correctly in Excel.
"""

from __future__ import annotations

import argparse
import csv
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List

import requests

SCRIPT_DIR = Path(__file__).resolve().parent
ROOT = SCRIPT_DIR.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def _parse_env_file(path: Path) -> None:
    """Minimal .env loader (no python-dotenv required). Does not override existing env."""
    try:
        text = path.read_text(encoding="utf-8-sig")
    except Exception:
        return
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[7:].strip()
        key, _, value = line.partition("=")
        key = key.strip()
        if not key or key in os.environ:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        os.environ[key] = value


def _load_env_files() -> list[Path]:
    """Load .env from cwd, script dir, then Site root (first found values win)."""
    loaded: list[Path] = []
    try:
        from dotenv import load_dotenv
        use_dotenv = True
    except ImportError:
        use_dotenv = False
        load_dotenv = None  # type: ignore

    candidates = [
        Path.cwd() / ".env",
        SCRIPT_DIR / ".env",
        ROOT / ".env",
    ]
    seen = set()
    for path in candidates:
        try:
            resolved = path.resolve()
        except Exception:
            continue
        if resolved in seen or not path.is_file():
            continue
        seen.add(resolved)
        if use_dotenv:
            load_dotenv(path, override=False)
        else:
            _parse_env_file(path)
        loaded.append(path)
    return loaded


_LOADED_ENV_FILES = _load_env_files()


def _require_env() -> tuple[str, str]:
    url = str(os.environ.get("SUPABASE_URL") or "").rstrip("/")
    key = str(os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    if not url or not key:
        searched = ", ".join(str(p) for p in [
            Path.cwd() / ".env",
            SCRIPT_DIR / ".env",
            ROOT / ".env",
        ])
        raise SystemExit(
            "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.\n"
            f"Looked for .env at: {searched}\n"
            "Put both vars in a .env next to this script (or in the folder you run from)."
        )
    return url, key


def _headers(service_key: str) -> dict:
    return {
        "Authorization": f"Bearer {service_key}",
        "apikey": service_key,
        "Accept": "application/json",
    }


def _display_name_from_auth(user: dict) -> str:
    meta = user.get("user_metadata") if isinstance(user.get("user_metadata"), dict) else {}
    candidates = [
        meta.get("full_name"),
        meta.get("name"),
        " ".join(
            part
            for part in [meta.get("given_name") or meta.get("first_name"), meta.get("family_name") or meta.get("last_name")]
            if str(part or "").strip()
        ).strip(),
        meta.get("given_name") or meta.get("first_name"),
    ]
    for item in candidates:
        val = str(item or "").strip()
        if val:
            return val
    email = str(user.get("email") or "").strip()
    if email and "@" in email:
        local = email.split("@", 1)[0].strip()
        return (local[:1].upper() + local[1:]) if local else ""
    return ""


def _fetch_credit_rows(s: requests.Session, supabase_url: str, service_key: str, minutes: int) -> List[dict]:
    """Page through user_credits rows with credit_minutes == minutes."""
    rows: List[dict] = []
    headers = _headers(service_key)
    offset = 0
    page_size = 1000
    while True:
        resp = s.get(
            f"{supabase_url}/rest/v1/user_credits",
            headers={**headers, "Range": f"{offset}-{offset + page_size - 1}"},
            params={
                "select": "user_id,user_name,credit_minutes,welcome_granted,updated_at",
                "credit_minutes": f"eq.{int(minutes)}",
                "order": "updated_at.desc",
            },
            timeout=30,
        )
        if resp.status_code not in (200, 206):
            raise RuntimeError(f"user_credits lookup failed: HTTP {resp.status_code} {resp.text[:300]}")
        batch = resp.json() if resp.text else []
        if not isinstance(batch, list) or not batch:
            break
        rows.extend(r for r in batch if isinstance(r, dict))
        if len(batch) < page_size:
            break
        offset += page_size
    return rows


def _list_auth_users_by_id(s: requests.Session, supabase_url: str, service_key: str) -> Dict[str, dict]:
    """Map user_id -> auth user (email + metadata)."""
    by_id: Dict[str, dict] = {}
    headers = _headers(service_key)
    page = 1
    per_page = 200
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
        for user in batch:
            if not isinstance(user, dict):
                continue
            uid = str(user.get("id") or "").strip()
            if uid:
                by_id[uid] = user
        if len(batch) < per_page:
            break
        page += 1
    return by_id


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Export users with N credit minutes to UTF-8 CSV.")
    p.add_argument("--minutes", type=int, default=60, help="Exact credit_minutes to match (default: 60).")
    p.add_argument("--output", help="Output CSV path.")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    minutes = int(args.minutes)
    supabase_url, service_key = _require_env()
    s = requests.Session()

    credit_rows = _fetch_credit_rows(s, supabase_url, service_key, minutes)
    auth_by_id = _list_auth_users_by_id(s, supabase_url, service_key)

    out_rows = []
    for row in credit_rows:
        uid = str(row.get("user_id") or "").strip()
        if not uid:
            continue
        auth_user = auth_by_id.get(uid) or {}
        email = str(auth_user.get("email") or "").strip()
        if not email:
            continue
        username = str(row.get("user_name") or "").strip() or _display_name_from_auth(auth_user)
        out_rows.append({"username": username, "email": email})

    out_rows.sort(key=lambda r: (r["username"].lower(), r["email"].lower()))

    if args.output:
        out_path = Path(args.output).expanduser()
    else:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        out_dir = ROOT / "exports"
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / f"users_credit_{minutes}_{stamp}.csv"

    out_path.parent.mkdir(parents=True, exist_ok=True)
    # utf-8-sig = UTF-8 with BOM so Excel keeps Hebrew readable
    with out_path.open("w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=["username", "email"])
        writer.writeheader()
        writer.writerows(out_rows)

    print(f"Wrote {len(out_rows)} users to {out_path}")
    print("Encoding: UTF-8 with BOM (Excel-safe for Hebrew)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
