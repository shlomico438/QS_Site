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
2. Get **sandbox** `TerminalNumber` + `ApiName` from Cardcom (often terminal `1000` for API tests).
3. Set on Koyeb:

```env
SIMULATION_MODE=false
CARDCOM_ENABLED=true
CARDCOM_SIMULATION=false
CARDCOM_SANDBOX=true
CARDCOM_TERMINAL_NUMBER=1000
CARDCOM_API_NAME=<your sandbox api name>
PUBLIC_BASE_URL=https://www.getquickscribe.com
```

4. Register webhook in Cardcom: `https://www.getquickscribe.com/api/cardcom/webhook`
5. Test with Cardcom test card `4580000000000000` (expiry/CVV per [Cardcom docs](https://cardcomapi.zendesk.com/hc/he/articles/28448202810514)).

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
