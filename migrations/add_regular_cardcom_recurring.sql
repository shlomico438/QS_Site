-- Cardcom token billing for regular Unlimited (monthly / annual).
-- Safe to run on its own: creates the plan columns if add_regular_billing_plans.sql
-- was not applied yet. The token table is service-role only.

ALTER TABLE public.user_credits
  ADD COLUMN IF NOT EXISTS billing_plan text,
  ADD COLUMN IF NOT EXISTS plan_period_end timestamptz,
  ADD COLUMN IF NOT EXISTS pay_use_minutes integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.user_credits.billing_plan IS
  'legacy (prepaid wallet), free (30 min reset each period), unlimited_monthly, unlimited_annual.';
COMMENT ON COLUMN public.user_credits.plan_period_end IS
  'When the current free or unlimited period ends.';
COMMENT ON COLUMN public.user_credits.pay_use_minutes IS
  'Minutes bought for a single pay-per-use file. Cleared to 0 after that file, even if unused.';

-- Existing wallets stay on their minutes until the balance reaches zero.
UPDATE public.user_credits
SET billing_plan = 'legacy'
WHERE billing_plan IS NULL;

CREATE OR REPLACE FUNCTION public.handle_new_user_welcome_credits()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.user_credits (
    user_id,
    credit_minutes,
    welcome_granted,
    billing_plan,
    plan_period_end,
    pay_use_minutes
  )
  VALUES (
    NEW.id,
    30,
    true,
    'free',
    now() + interval '30 days',
    0
  )
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

ALTER TABLE public.user_credits
  ADD COLUMN IF NOT EXISTS unlimited_renew text NOT NULL DEFAULT 'off';

ALTER TABLE public.user_credits
  DROP CONSTRAINT IF EXISTS user_credits_unlimited_renew_check;

ALTER TABLE public.user_credits
  ADD CONSTRAINT user_credits_unlimited_renew_check
  CHECK (unlimited_renew IN ('on', 'off', 'past_due'));

COMMENT ON COLUMN public.user_credits.unlimited_renew IS
  'on: charge the saved Cardcom token when the Unlimited period ends. off: cancelled or never tokenized. past_due: last token charge failed.';

CREATE INDEX IF NOT EXISTS idx_user_credits_unlimited_renew_due
  ON public.user_credits (plan_period_end)
  WHERE unlimited_renew = 'on'
    AND billing_plan IN ('unlimited_monthly', 'unlimited_annual');

CREATE TABLE IF NOT EXISTS public.regular_billing_methods (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  cardcom_token text NOT NULL,
  card_validity_mmyy text NOT NULL,
  card_last_four text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.regular_billing_methods IS
  'Service-role-only Cardcom token for regular Unlimited renewals. Never expose to the client.';

CREATE TABLE IF NOT EXISTS public.regular_cardcom_renewals (
  order_id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  plan text NOT NULL,
  amount_ils numeric(10, 2) NOT NULL CHECK (amount_ils > 0),
  period_end_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'charged', 'paid', 'failed')),
  cardcom_transaction_id text,
  invoice_number text,
  invoice_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_regular_cardcom_renewal_period
  ON public.regular_cardcom_renewals (user_id, period_end_key);

COMMENT ON TABLE public.regular_cardcom_renewals IS
  'One Cardcom token charge per Unlimited period. period_end_key blocks a second charge for the same period.';

ALTER TABLE public.regular_billing_methods ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.regular_cardcom_renewals ENABLE ROW LEVEL SECURITY;

-- Unlimited checkout stores credit_minutes = 0 and bundle ids outside the original packs.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public'
      AND rel.relname = 'cardcom_credit_purchases'
      AND con.contype = 'c'
      AND (
        pg_get_constraintdef(con.oid) ILIKE '%bundle_id%'
        OR pg_get_constraintdef(con.oid) ILIKE '%credit_minutes%'
      )
  LOOP
    EXECUTE format(
      'ALTER TABLE public.cardcom_credit_purchases DROP CONSTRAINT %I',
      r.conname
    );
  END LOOP;
END $$;

ALTER TABLE public.cardcom_credit_purchases
  DROP CONSTRAINT IF EXISTS cardcom_credit_purchases_credit_minutes_nonnegative;

ALTER TABLE public.cardcom_credit_purchases
  ADD CONSTRAINT cardcom_credit_purchases_credit_minutes_nonnegative
  CHECK (credit_minutes >= 0);

NOTIFY pgrst, 'reload schema';
