-- Cardcom Low Profile checkout records for pay-as-you-go credit bundles.
-- Apply in Supabase Dashboard -> SQL Editor before production Cardcom payments.
-- Optional for local SIMULATION_MODE (in-memory fallback when table is missing).

CREATE TABLE IF NOT EXISTS public.cardcom_credit_purchases (
  order_id text PRIMARY KEY,
  low_profile_id text,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  bundle_id text NOT NULL CHECK (bundle_id IN ('light', 'standard', 'plus')),
  credit_minutes integer NOT NULL CHECK (credit_minutes > 0),
  amount_ils numeric(10, 2) NOT NULL CHECK (amount_ils > 0),
  tranzaction_id bigint,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed')),
  credited_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.cardcom_credit_purchases IS 'Idempotent Cardcom Low Profile purchases credited to user_credits.';
COMMENT ON COLUMN public.cardcom_credit_purchases.order_id IS 'ReturnValue sent to Cardcom (e.g. qs_cc_<uuid>).';
COMMENT ON COLUMN public.cardcom_credit_purchases.low_profile_id IS 'Cardcom LowProfileId from Create response.';
COMMENT ON COLUMN public.cardcom_credit_purchases.credited_at IS 'Set after purchased minutes are added to the wallet.';

CREATE INDEX IF NOT EXISTS idx_cardcom_credit_purchases_low_profile
  ON public.cardcom_credit_purchases (low_profile_id)
  WHERE low_profile_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cardcom_credit_purchases_user_created
  ON public.cardcom_credit_purchases (user_id, created_at DESC);

ALTER TABLE public.cardcom_credit_purchases ENABLE ROW LEVEL SECURITY;
