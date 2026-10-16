#!/usr/bin/env python3
"""One-shot: parse Zoho feedback .eml-like files from Downloads and insert into user_feedback."""
from __future__ import annotations

import os
import re
import sys
from datetime import datetime, timezone
from email import message_from_bytes
from email.utils import parsedate_to_datetime
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]


def _load_dotenv():
    env_path = ROOT / ".env"
    if not env_path.is_file():
        return
    for line in env_path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def _feedback_files():
    downloads = Path.home() / "Downloads"
    out = []
    for f in downloads.iterdir():
        n = f.name.lower()
        if "user feedback" not in n:
            continue
        if n.startswith("re") or n.startswith("re_"):
            continue
        out.append(f)
    return sorted(out, key=lambda p: p.name)


def _section(body: str, start: str, end_markers: list[str]) -> str:
    low = body
    idx = low.find(start)
    if idx < 0:
        return ""
    rest = body[idx + len(start) :]
    cut = len(rest)
    for m in end_markers:
        j = rest.find(m)
        if j >= 0:
            cut = min(cut, j)
    return rest[:cut].strip()


def _parse_one(path: Path) -> dict | None:
    raw = path.read_bytes()
    msg = message_from_bytes(raw)
    payload = msg.get_payload(decode=True)
    if payload is None:
        body = str(msg.get_payload() or "")
    else:
        charset = msg.get_content_charset() or "utf-8"
        body = payload.decode(charset, errors="replace")
    body = body.replace("\r\n", "\n")
    email = _section(body, "User email:", ["\nName:", "\nStar rating:"])
    name = _section(body, "Name:", ["\nStar rating:", "\nWhat they liked:"])
    star_raw = _section(body, "Star rating:", ["\n\nWhat they liked:", "\nWhat they liked:"])
    liked = _section(body, "What they liked:\n", ["\nWhat to improve:"])
    improve = _section(body, "What to improve:\n", [])
    if liked.lower() == "(empty)":
        liked = ""
    if improve.lower() == "(empty)":
        improve = ""
    stars = 0
    if re.fullmatch(r"[1-5]", star_raw.strip()):
        stars = int(star_raw.strip())
    created = None
    date_hdr = msg.get("Date")
    if date_hdr:
        try:
            created = parsedate_to_datetime(date_hdr)
            if created.tzinfo is None:
                created = created.replace(tzinfo=timezone.utc)
        except Exception:
            created = None
    email = (email or "").strip().lower()
    if not email:
        return None
    if email == "sarit@semel.org.il":
        stars = 5
    return {
        "email": email[:320],
        "name": (name or "").strip()[:200],
        "stars": stars,
        "liked": liked.strip()[:2000],
        "improve": improve.strip()[:2000],
        "source": "email_import",
        "created_at": created.isoformat() if created else None,
    }


def _display_name(name, email=""):
    raw = str(name or "").strip()
    if raw:
        raw = raw.replace("|", " ").split()[0].strip(".,;:")[:40]
        if raw and "@" not in raw:
            return raw
    return ""


def _supabase_rest():
    url = (os.environ.get("SUPABASE_URL") or "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or ""
    if not url or not key:
        raise SystemExit("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing in .env")
    return url, {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }


def main():
    _load_dotenv()

    rows = []
    seen = set()
    for path in _feedback_files():
        parsed = _parse_one(path)
        if not parsed:
            print("skip unreadable", path.name)
            continue
        key = (parsed["email"], parsed["created_at"], parsed["stars"], parsed["liked"], parsed["improve"])
        if key in seen:
            print("skip duplicate", parsed["email"], parsed["created_at"])
            continue
        seen.add(key)
        rows.append(parsed)
        print(
            f"ok {parsed['email']} stars={parsed['stars']} "
            f"name={parsed['name']!r} date={parsed['created_at']}"
        )

    if not rows:
        raise SystemExit("no rows parsed")

    seed = ROOT / "data" / "user_feedback_import.json"
    seed.parent.mkdir(parents=True, exist_ok=True)
    seed.write_text(
        __import__("json").dumps(rows, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print("wrote", seed)

    supabase_url, headers = _supabase_rest()
    inserted = 0
    for row in rows:
        payload = {
            "source": row["source"],
            "stars": row["stars"],
            "liked": row["liked"] or None,
            "improve": row["improve"] or None,
            "email": row["email"],
            "name": row["name"] or None,
            "display_name": _display_name(row["name"], row["email"]) or None,
            "is_public": row["stars"] >= 1,
        }
        if row["created_at"]:
            payload["created_at"] = row["created_at"]
        r = requests.post(
            f"{supabase_url}/rest/v1/user_feedback",
            headers={**headers, "Prefer": "return=representation"},
            json=payload,
            timeout=20,
        )
        if r.status_code not in (200, 201):
            print("INSERT FAIL", r.status_code, r.text[:400], payload.get("email"))
            continue
        inserted += 1
    print(f"inserted {inserted}/{len(rows)}")


if __name__ == "__main__":
    main()
