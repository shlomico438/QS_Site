-- Stripe checkout records for pay-as-you-go credit bundles.
-- Apply in Supabase Dashboard -> SQL Editor before enabling paid credits.

CREATE TABLE IF NOT EXISTS public.stripe_credit_purchases (
  stripe_session_id text PRIMARY KEY,
  stripe_payment_intent text,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  bundle_id text NOT NULL CHECK (bundle_id IN ('light', 'standard', 'plus')),
  credit_minutes integer NOT NULL CHECK (credit_minutes > 0),
  amount_ils integer NOT NULL CHECK (amount_ils > 0),
  credited_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.stripe_credit_purchases IS 'Idempotent Stripe Checkout purchases credited to user_credits.';
COMMENT ON COLUMN public.stripe_credit_purchases.credited_at IS 'Set after purchased minutes are added to the wallet.';

CREATE INDEX IF NOT EXISTS idx_stripe_credit_purchases_user_created
  ON public.stripe_credit_purchases (user_id, created_at DESC);

ALTER TABLE public.stripe_credit_purchases ENABLE ROW LEVEL SECURITY;
