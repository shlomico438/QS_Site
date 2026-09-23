#!/usr/bin/env python3
"""Issue a Cardcom tax invoice/receipt for an already-paid medical subscription.

Needs production env (Cardcom + Supabase service role), and the doctor's
ת.ז./ח.פ. + city (required by Cardcom documents).

Example:

  python scripts/issue_medical_invoice.py \\
    --order-id qs_med_4839ce6ea6ec4003a0f07c524290ba7b \\
    --tax-id 123456789 \\
    --city "תל אביב"

Or against a live deploy:

  curl -sS -X POST https://www.getquickscribe.com/api/medical/cardcom/issue-invoice \\
    -H "X-Medical-Billing-Secret: $MEDICAL_BILLING_CRON_SECRET" \\
    -H "Content-Type: application/json" \\
    -d '{"order_id":"qs_med_4839ce6ea6ec4003a0f07c524290ba7b","tax_id":"123456789","city":"תל אביב"}'
"""

from __future__ import annotations

import argparse
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)


def main() -> int:
    parser = argparse.ArgumentParser(description="Issue a medical Cardcom invoice for a paid order")
    parser.add_argument("--order-id", required=True)
    parser.add_argument("--tax-id", required=True, help="Israeli ID / company number")
    parser.add_argument("--city", required=True, help="City (ישוב) for the invoice")
    parser.add_argument("--email", default="", help="Override doctor email if Auth lookup is empty")
    args = parser.parse_args()

    from medical_saas import _medical_issue_invoice_for_payment

    result = _medical_issue_invoice_for_payment(
        args.order_id.strip(),
        {"tax_id": args.tax_id, "city": args.city},
        args.email.strip(),
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
