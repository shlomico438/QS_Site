# QuickScribe Medical SaaS setup

## 1. Database

Run `migrations/add_medical_saas_accounts.sql` in the Supabase SQL Editor.

The migration creates:

- Medical professional profiles and trial/subscription state
- Current billing-period counters
- An idempotent transcription usage ledger
- Service-role-only Cardcom token storage
- Subscription payment records
- Atomic usage and plan-activation SQL functions

## 2. Cardcom

The Cardcom terminal must be enabled by Cardcom/Shva for:

- `ChargeAndCreateToken` through Low Profile
- Token charging through `Transactions/Transaction`
- Recurring/direct-debit transactions (`IsAutoRecurringPayment`)

Use the existing Cardcom variables:

- `CARDCOM_ENABLED=true`
- `CARDCOM_TERMINAL_NUMBER`
- `CARDCOM_API_NAME`
- `CARDCOM_API_PASSWORD`
- `CARDCOM_SANDBOX=true` while testing Cardcom's hosted sandbox

Internal `SIMULATION_MODE` activates a medical plan without contacting Cardcom.

## 3. Monthly renewals and overage

Set a long random value:

```text
MEDICAL_BILLING_CRON_SECRET=<random-secret>
```

Schedule one authenticated request daily:

```http
POST https://www.getquickscribe.com/api/medical/cardcom/run-renewals
X-Medical-Billing-Secret: <random-secret>
Content-Type: application/json

{"limit": 50}
```

For every due account, the endpoint:

1. Charges the monthly plan.
2. Adds accrued overage at ₪6/hour.
3. Starts the next billing cycle and resets current usage only after a successful charge.
4. Marks the subscription `past_due` after a failed charge.

The partial unique index on user, payment kind, and billing-cycle start prevents duplicate renewal charges when the cron request is retried.

## 4. Production checks

- Complete a hosted Cardcom sandbox checkout and confirm that `GetLpResult` returns a reusable token and expiry.
- Run the renewal endpoint against a due sandbox account.
- Verify that a signed-out `/medical` user cannot presign an upload, trigger processing, start live transcription, or warm the medical endpoint.
- Verify that `/` and `/en` still allow the regular anonymous transcription flow.

## 5. Invoices (tax invoice + receipt)

Medical checkout now attaches a Cardcom `Document` (`TaxInvoiceAndReceipt`) and emails it to the doctor (`CARDCOM_INVOICE_EMAIL`, default on). The doctor is asked for **ת.ז. / ח.פ.** and **ישוב** before Cardcom redirect — same modal as regular credit purchases.

Apply `migrations/add_medical_invoice_columns.sql` so `invoice_number` / `invoice_url` persist on `medical_subscription_payments`.

Ops also get the same “payment received” email as regular Cardcom purchases.

### Issue an invoice for a charge that already completed without a document

You need the doctor's ID/company number and city:

```http
POST /api/medical/cardcom/issue-invoice
X-Medical-Billing-Secret: <MEDICAL_BILLING_CRON_SECRET>
Content-Type: application/json

{
  "order_id": "qs_med_4839ce6ea6ec4003a0f07c524290ba7b",
  "tax_id": "123456789",
  "city": "תל אביב"
}
```

Or locally with production env:

```text
python scripts/issue_medical_invoice.py --order-id qs_med_... --tax-id 123456789 --city "תל אביב"
```
