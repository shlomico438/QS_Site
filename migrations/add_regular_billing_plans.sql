-- Regular pricing: free 30 min/month, unlimited month/year, pay-per-use.
-- Existing rows keep their minute wallet (billing_plan = legacy) until it
-- reaches zero. Apply in Supabase Dashboard → SQL Editor.

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

-- Grandfather everyone who already has a wallet. Do not convert their minutes.
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

NOTIFY pgrst, 'reload schema';
