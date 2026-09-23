#!/usr/bin/env python3
"""Create referral codes + stored invite emails for existing users.

Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (same as the Site app).
Run from the Site repo after applying migrations/add_referrals.sql.
"""

from __future__ import annotations

import os
import sys

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from referrals import ensure_profile  # noqa: E402


def _list_user_ids():
    import siteapp as sa

    supabase_url, _key, headers = sa._supabase_rest_config()
    r = sa._supabase_http_request(
        "GET",
        f"{supabase_url}/rest/v1/user_credits?select=user_id,user_name&order=created_at.asc",
        headers=headers,
    )
    if r.status_code != 200:
        raise RuntimeError(r.text or f"user_credits HTTP {r.status_code}")
    return r.json() if r.text else []


def main():
    rows = _list_user_ids()
    created = 0
    for row in rows or []:
        user_id = str((row or {}).get("user_id") or "").strip()
        if not user_id:
            continue
        name = str((row or {}).get("user_name") or "").strip()
        profile = ensure_profile(user_id, display_name=name)
        if profile:
            created += 1
            print(f"{user_id} {profile.get('code')} {profile.get('referral_link')}")
    print(f"profiles={created}")


if __name__ == "__main__":
    main()
