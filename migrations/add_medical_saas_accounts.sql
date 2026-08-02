-- QuickScribe Medical: onboarding, trial/subscription state, and metered usage.
-- Apply in Supabase Dashboard -> SQL Editor.

CREATE TABLE IF NOT EXISTS public.medical_accounts (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name text NOT NULL,
  professional_specialty text NOT NULL,
  trial_started_at timestamptz NOT NULL DEFAULT now(),
  trial_expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  subscription_plan text NOT NULL DEFAULT 'trial'
    CHECK (subscription_plan IN ('trial', 'starter', 'professional', 'clinic')),
  subscription_status text NOT NULL DEFAULT 'trialing'
    CHECK (subscription_status IN ('trialing', 'active', 'past_due', 'canceled', 'expired')),
  billing_cycle_started_at timestamptz NOT NULL DEFAULT now(),
  billing_cycle_ends_at timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  included_seconds integer NOT NULL DEFAULT 108000 CHECK (included_seconds >= 0),
  current_period_usage_seconds bigint NOT NULL DEFAULT 0 CHECK (current_period_usage_seconds >= 0),
  overage_seconds bigint NOT NULL DEFAULT 0 CHECK (overage_seconds >= 0),
  overage_rate_agorot_per_hour integer NOT NULL DEFAULT 600 CHECK (overage_rate_agorot_per_hour >= 0),
  seat_limit integer NOT NULL DEFAULT 1 CHECK (seat_limit BETWEEN 1 AND 5),
  cardcom_customer_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.medical_accounts IS
  'QuickScribe Medical trial, professional profile, subscription entitlement, and current billing-period usage.';
COMMENT ON COLUMN public.medical_accounts.included_seconds IS
  'Included transcription allowance for the active trial/billing period (30h=108000, 60h=216000, 180h=648000).';
COMMENT ON COLUMN public.medical_accounts.overage_rate_agorot_per_hour IS
  'Additional transcription rate in Israeli agorot per hour (600 = ILS 6/hour).';

CREATE TABLE IF NOT EXISTS public.medical_usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  runpod_job_id text NOT NULL,
  duration_seconds numeric(12, 3) NOT NULL CHECK (duration_seconds > 0),
  billing_cycle_started_at timestamptz NOT NULL,
  billing_cycle_ends_at timestamptz NOT NULL,
  included_seconds_at_charge integer NOT NULL CHECK (included_seconds_at_charge >= 0),
  overage_seconds_after_charge bigint NOT NULL DEFAULT 0 CHECK (overage_seconds_after_charge >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, runpod_job_id)
);

COMMENT ON TABLE public.medical_usage_events IS
  'Append-only, idempotent server-side ledger of completed medical transcription duration.';

CREATE TABLE IF NOT EXISTS public.medical_billing_methods (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  cardcom_token text NOT NULL,
  card_validity_mmyy text NOT NULL,
  card_last_four text,
  token_created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.medical_billing_methods IS
  'Service-role-only Cardcom token data for recurring medical subscriptions. Never exposed through client policies.';

CREATE TABLE IF NOT EXISTS public.medical_subscription_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  order_id text NOT NULL UNIQUE,
  low_profile_id text,
  plan text NOT NULL CHECK (plan IN ('starter', 'professional', 'clinic')),
  amount_ils numeric(10, 2) NOT NULL CHECK (amount_ils > 0),
  payment_kind text NOT NULL DEFAULT 'initial'
    CHECK (payment_kind IN ('initial', 'renewal', 'overage')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'paid', 'failed')),
  cardcom_transaction_id text,
  billing_cycle_started_at timestamptz,
  billing_cycle_ends_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_medical_usage_user_created
  ON public.medical_usage_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_medical_subscription_payments_user_created
  ON public.medical_subscription_payments (user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_medical_renewal_cycle
  ON public.medical_subscription_payments (user_id, payment_kind, billing_cycle_started_at)
  WHERE payment_kind = 'renewal';
CREATE INDEX IF NOT EXISTS idx_medical_accounts_cycle_end
  ON public.medical_accounts (billing_cycle_ends_at)
  WHERE subscription_status = 'active';

CREATE OR REPLACE FUNCTION public.set_medical_account_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_medical_accounts_updated_at ON public.medical_accounts;
CREATE TRIGGER trg_medical_accounts_updated_at
BEFORE UPDATE ON public.medical_accounts
FOR EACH ROW EXECUTE FUNCTION public.set_medical_account_updated_at();

-- Atomic/idempotent metering. Call with service role only after successful transcription.
CREATE OR REPLACE FUNCTION public.record_medical_usage(
  p_user_id uuid,
  p_runpod_job_id text,
  p_duration_seconds numeric
)
RETURNS public.medical_accounts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  acct public.medical_accounts%ROWTYPE;
  next_usage bigint;
  next_overage bigint;
BEGIN
  IF p_duration_seconds IS NULL OR p_duration_seconds <= 0 THEN
    RAISE EXCEPTION 'duration_seconds must be positive';
  END IF;

  SELECT * INTO acct
  FROM public.medical_accounts
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'medical account not found';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.medical_usage_events
    WHERE user_id = p_user_id AND runpod_job_id = p_runpod_job_id
  ) THEN
    RETURN acct;
  END IF;

  next_usage := acct.current_period_usage_seconds + CEIL(p_duration_seconds)::bigint;
  next_overage := GREATEST(0, next_usage - acct.included_seconds);

  INSERT INTO public.medical_usage_events (
    user_id,
    runpod_job_id,
    duration_seconds,
    billing_cycle_started_at,
    billing_cycle_ends_at,
    included_seconds_at_charge,
    overage_seconds_after_charge
  ) VALUES (
    p_user_id,
    p_runpod_job_id,
    p_duration_seconds,
    acct.billing_cycle_started_at,
    acct.billing_cycle_ends_at,
    acct.included_seconds,
    next_overage
  );

  UPDATE public.medical_accounts
  SET current_period_usage_seconds = next_usage,
      overage_seconds = next_overage,
      updated_at = now()
  WHERE user_id = p_user_id
  RETURNING * INTO acct;

  RETURN acct;
END;
$$;

-- Starts/resets a paid billing period after a verified Cardcom charge.
CREATE OR REPLACE FUNCTION public.activate_medical_plan(
  p_user_id uuid,
  p_plan text,
  p_cycle_started_at timestamptz DEFAULT now()
)
RETURNS public.medical_accounts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  plan_seconds integer;
  plan_seats integer;
  acct public.medical_accounts%ROWTYPE;
BEGIN
  plan_seconds := CASE p_plan
    WHEN 'starter' THEN 108000
    WHEN 'professional' THEN 216000
    WHEN 'clinic' THEN 648000
    ELSE NULL
  END;
  plan_seats := CASE WHEN p_plan = 'clinic' THEN 5 ELSE 1 END;
  IF plan_seconds IS NULL THEN
    RAISE EXCEPTION 'invalid medical plan';
  END IF;

  UPDATE public.medical_accounts
  SET subscription_plan = p_plan,
      subscription_status = 'active',
      billing_cycle_started_at = p_cycle_started_at,
      billing_cycle_ends_at = p_cycle_started_at + interval '1 month',
      included_seconds = plan_seconds,
      current_period_usage_seconds = 0,
      overage_seconds = 0,
      seat_limit = plan_seats,
      updated_at = now()
  WHERE user_id = p_user_id
  RETURNING * INTO acct;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'medical account not found';
  END IF;
  RETURN acct;
END;
$$;

REVOKE ALL ON FUNCTION public.record_medical_usage(uuid, text, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.activate_medical_plan(uuid, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_medical_usage(uuid, text, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.activate_medical_plan(uuid, text, timestamptz) TO service_role;

ALTER TABLE public.medical_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.medical_usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.medical_billing_methods ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.medical_subscription_payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS medical_accounts_select_own ON public.medical_accounts;
CREATE POLICY medical_accounts_select_own ON public.medical_accounts
FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS medical_usage_select_own ON public.medical_usage_events;
CREATE POLICY medical_usage_select_own ON public.medical_usage_events
FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS medical_payments_select_own ON public.medical_subscription_payments;
CREATE POLICY medical_payments_select_own ON public.medical_subscription_payments
FOR SELECT USING (auth.uid() = user_id);

-- No client policies for billing methods; service role only.

NOTIFY pgrst, 'reload schema';
