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
