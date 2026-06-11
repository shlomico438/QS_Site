# Cardcom credit payments (Hebrew / ILS)

Pay-as-you-go credit bundles use **Cardcom Low Profile** redirect checkout for Hebrew (`he`) locales. English (`en`) continues to use **Stripe** (USD).

There are **three separate modes** — do not confuse them:

| Mode | When | Checkout page |
|------|------|----------------|
| **Internal simulation** | Local dev, `SIMULATION_MODE=true` | Green QuickScribe page `/cardcom/sim-checkout` |
| **Cardcom sandbox** | Production deploy, test terminal | Real Cardcom hosted page (test cards) |
| **Cardcom live** | Production, live terminal | Real Cardcom hosted page (real charges) |

Check active mode: `GET /api/cardcom/status` → `api_mode`: `internal_sim` | `sandbox` | `live` | `off`.

---

## 1. Internal simulation (local dev)

With `SIMULATION_MODE=true` (F5 default), no Cardcom credentials are required:

1. Sign in on the Hebrew site (`/`).
2. Pricing → **Buy credits**.
3. Green page `/cardcom/sim-checkout` → **שלם (סימולציה)**.
4. Wallet credited; return URL `/?cardcom_success=1&order_id=…`.

```env
SIMULATION_MODE=true
CARDCOM_ENABLED=true
```

| Variable | Effect |
|----------|--------|
| `CARDCOM_SIMULATION=1` | Force green page even if `SIMULATION_MODE=0` |
| `CARDCOM_FORCE_LIVE=1` | Use Cardcom API instead of green page (needs credentials + public URL) |

---

## 2. Production + Cardcom sandbox (recommended next step)

Deploy with **`SIMULATION_MODE=false`** (real transcription, etc.) but keep **Cardcom test environment** — users see the real Cardcom payment page; only test cards are charged.

1. Apply `migrations/add_cardcom_credit_purchases.sql` in Supabase.
2. In the **Cardcom merchant portal**, create or open an **API interface user** (ממשקים / API). Cardcom gives you a matched set:
   - `TerminalNumber` (מסוף)
   - `ApiName` (שם משתמש)
   - `ApiPassword` (סיסמה)
   
   These three must belong to the **same** interface. Do not mix terminal `1000` from docs with your own username unless Cardcom explicitly issued that pair to you.

3. Set on Koyeb:

```env
SIMULATION_MODE=false
CARDCOM_ENABLED=true
CARDCOM_SIMULATION=false
CARDCOM_SANDBOX=true
CARDCOM_TERMINAL_NUMBER=<your terminal>
CARDCOM_API_NAME=<your api username>
CARDCOM_API_PASSWORD=<your api password>
PUBLIC_BASE_URL=https://www.getquickscribe.com
```

### Troubleshooting: `שם משתמש או סיסמה שגויים`

Cardcom returned **wrong username or password** — the app reached Cardcom, but credentials are wrong or mismatched. Fix env vars in Koyeb (redeploy after save). Common mistakes:

- `CARDCOM_API_NAME` typo or portal login password used instead of **API interface** password
- `CARDCOM_TERMINAL_NUMBER` does not match the terminal tied to that API user
- `CARDCOM_API_PASSWORD` missing (add it — see [Cardcom Low Profile docs](https://cardcomapi.zendesk.com/hc/he/articles/28448202810514))

4. Register webhook in Cardcom: `https://www.getquickscribe.com/api/cardcom/webhook`
5. Test with Cardcom test card `4580000000000000` (expiry/CVV per [Cardcom docs](https://cardcomapi.zendesk.com/hc/he/articles/28448202810514)).
6. **Invoices (optional):** enable the **Documents** model on your Cardcom terminal, set `CARDCOM_INVOICES=true` (default on in sandbox), run `migrations/add_cardcom_invoice_columns.sql`, then complete a sandbox purchase — Cardcom issues **TaxInvoiceAndReceipt** with the charge. See [Invoices](#invoices-tax-invoice--receipt) below.

**Important:** `CARDCOM_SIMULATION=false` disables the green page. `CARDCOM_SANDBOX=true` marks sandbox mode in logs/status only; the API host is the same (`https://secure.cardcom.solutions/api/v11`).

Copy-paste template: [`env.cardcom.example`](../env.cardcom.example).

---

## 3. Production + Cardcom live

When ready for real ILS charges, switch to your **live** terminal from Cardcom:

```env
SIMULATION_MODE=false
CARDCOM_ENABLED=true
CARDCOM_SIMULATION=false
CARDCOM_SANDBOX=false
CARDCOM_TERMINAL_NUMBER=<live terminal>
CARDCOM_API_NAME=<live api name>
PUBLIC_BASE_URL=https://www.getquickscribe.com
```

Startup logs will show `Cardcom LIVE payments enabled`.

---

## Invoices (tax invoice + receipt)

For **credit card checkout**, Cardcom expects the invoice on **`LowProfile/Create`** (not the standalone `Documents/CreateTaxInvoice` API, which is for cash/check/bank transfers or retroactive linking).

QuickScribe sends a `Document` block when `CARDCOM_INVOICES=true` ( **default on in sandbox**, off in live unless you set the env var):

| Env | Default | Purpose |
|-----|---------|---------|
| `CARDCOM_INVOICES` | `true` in sandbox, `false` in live | Attach `Document` to checkout |
| `CARDCOM_INVOICE_TYPE` | `TaxInvoiceAndReceipt` | חשבונית מס קבלה |
| `CARDCOM_INVOICE_EMAIL` | `true` | Email invoice to signed-in user |

**Cardcom merchant portal:** enable the **Documents** (מסמכים) business model on the terminal. Without it, payment may still succeed but `DocumentInfo` in `GetLpResult` will fail.

**After payment:** `confirm-payment` returns `invoice_number`, `invoice_type`, and `invoice_url` when Cardcom provides them. Apply `migrations/add_cardcom_invoice_columns.sql` to persist them in Supabase.

**Sandbox test:** deploy with sandbox credentials + `CARDCOM_INVOICES=true` → buy credits on `/` → check Koyeb logs for `cardcom invoice document` → in Cardcom portal, open the transaction document list → confirm email if `CARDCOM_INVOICE_EMAIL=true`.

**Billing fields:** Cardcom requires **ת.ז. / ח.פ.** (`TaxId`) and **ישוב** (`City`) on the invoice. The Hebrew checkout shows a short modal before redirect; values are sent as `invoice_tax_id` and `invoice_city` and cached in `localStorage` for repeat purchases.

References: [Low Profile + Document](https://cardcomapi.zendesk.com/hc/he/articles/28448202810514), [Create Tax invoice (standalone)](https://cardcomapi.zendesk.com/hc/he/articles/25360043043602).

---

## Flow (sandbox or live)

`POST /api/cardcom/create-payment` → Cardcom redirect → webhook → `GetLpResult` verify → credit wallet → browser `SuccessRedirectUrl` → `POST /api/cardcom/confirm-payment` (idempotent).

## API routes

| Route | Purpose |
|-------|---------|
| `GET /api/cardcom/status` | Mode: internal_sim / sandbox / live |
| `POST /api/cardcom/create-payment` | Start checkout (auth required) |
| `POST /api/cardcom/webhook` | Cardcom server callback |
| `POST /api/cardcom/confirm-payment` | After browser return (auth required) |
| `POST /api/cardcom/sim-complete` | Internal simulation only |
| `GET /cardcom/sim-checkout` | Internal simulation UI |

## Frontend

`templates/index.html` sends Hebrew checkout to Cardcom and English to Stripe.
