-- Durable per-email entitlements (welcome minutes + medical trial).
-- Survives auth.users deletion so delete-and-rejoin cannot mint a second 60 minutes.
-- Apply in Supabase Dashboard → SQL Editor.

CREATE OR REPLACE FUNCTION public.normalize_entitlement_email(p_email text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  raw text;
  local_part text;
  domain text;
  atpos int;
BEGIN
  raw := lower(btrim(COALESCE(p_email, '')));
  atpos := position('@' in raw);
  IF atpos <= 1 THEN
    RETURN '';
  END IF;
  local_part := btrim(substr(raw, 1, atpos - 1));
  domain := btrim(btrim(substr(raw, atpos + 1)), '.');
  IF local_part = '' OR domain = '' OR position('.' in domain) = 0 THEN
    RETURN '';
  END IF;
  IF domain = 'googlemail.com' THEN
    domain := 'gmail.com';
  END IF;
  IF position('+' in local_part) > 0 THEN
    local_part := split_part(local_part, '+', 1);
  END IF;
  IF domain = 'gmail.com' THEN
    local_part := replace(local_part, '.', '');
  END IF;
  IF btrim(local_part) = '' THEN
    RETURN '';
  END IF;
  RETURN btrim(local_part) || '@' || domain;
END;
$$;

CREATE TABLE IF NOT EXISTS public.entitlement_ledger (
  email_key text PRIMARY KEY,
  welcome_granted boolean NOT NULL DEFAULT false,
  welcome_minutes_granted integer NOT NULL DEFAULT 0 CHECK (welcome_minutes_granted >= 0),
  credit_minutes_snapshot integer CHECK (credit_minutes_snapshot IS NULL OR credit_minutes_snapshot >= 0),
  medical_trial_used boolean NOT NULL DEFAULT false,
  medical_trial_started_at timestamptz,
  medical_trial_expires_at timestamptz,
  medical_usage_seconds bigint,
  medical_included_seconds integer,
  medical_subscription_plan text,
  medical_subscription_status text,
  medical_billing_cycle_started_at timestamptz,
  medical_billing_cycle_ends_at timestamptz,
  last_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_deleted_at timestamptz
);

COMMENT ON TABLE public.entitlement_ledger IS
  'Per-normalized-email welcome/trial grants. Not keyed on auth.users, so it survives account deletion.';
COMMENT ON COLUMN public.entitlement_ledger.email_key IS
  'Output of public.normalize_entitlement_email(email).';
COMMENT ON COLUMN public.entitlement_ledger.credit_minutes_snapshot IS
  'Wallet minutes remaining at last delete; restored on re-signup instead of a fresh 60.';

CREATE OR REPLACE FUNCTION public.set_entitlement_ledger_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_entitlement_ledger_updated_at ON public.entitlement_ledger;
CREATE TRIGGER trg_entitlement_ledger_updated_at
BEFORE UPDATE ON public.entitlement_ledger
FOR EACH ROW
EXECUTE FUNCTION public.set_entitlement_ledger_updated_at();

CREATE OR REPLACE FUNCTION public.handle_new_user_welcome_credits()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_key text;
  v_granted boolean;
  v_snapshot integer;
  v_minutes integer;
BEGIN
  v_key := public.normalize_entitlement_email(NEW.email);

  IF v_key IS NULL OR v_key = '' THEN
    PERFORM public.grant_welcome_credits(NEW.id, 60);
    RETURN NEW;
  END IF;

  SELECT el.welcome_granted, el.credit_minutes_snapshot
    INTO v_granted, v_snapshot
  FROM public.entitlement_ledger el
  WHERE el.email_key = v_key;

  IF v_granted IS TRUE THEN
    v_minutes := GREATEST(0, COALESCE(v_snapshot, 0));
    PERFORM public.grant_welcome_credits(NEW.id, v_minutes);
    UPDATE public.entitlement_ledger
    SET last_user_id = NEW.id
    WHERE email_key = v_key;
  ELSE
    PERFORM public.grant_welcome_credits(NEW.id, 60);
    INSERT INTO public.entitlement_ledger (
      email_key, welcome_granted, welcome_minutes_granted, last_user_id
    ) VALUES (v_key, true, 60, NEW.id)
    ON CONFLICT (email_key) DO UPDATE
    SET
      welcome_granted = true,
      welcome_minutes_granted = GREATEST(
        public.entitlement_ledger.welcome_minutes_granted,
        EXCLUDED.welcome_minutes_granted
      ),
      last_user_id = EXCLUDED.last_user_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created_welcome_credits ON auth.users;
CREATE TRIGGER on_auth_user_created_welcome_credits
AFTER INSERT ON auth.users
FOR EACH ROW
EXECUTE FUNCTION public.handle_new_user_welcome_credits();

-- Current users: seed the ledger so a later delete+rejoin cannot mint a second pack.
INSERT INTO public.entitlement_ledger (
  email_key,
  welcome_granted,
  welcome_minutes_granted,
  last_user_id
)
SELECT DISTINCT ON (public.normalize_entitlement_email(u.email))
  public.normalize_entitlement_email(u.email),
  COALESCE(uc.welcome_granted, false),
  CASE WHEN COALESCE(uc.welcome_granted, false) THEN 60 ELSE 0 END,
  u.id
FROM auth.users u
LEFT JOIN public.user_credits uc ON uc.user_id = u.id
WHERE public.normalize_entitlement_email(u.email) <> ''
ORDER BY public.normalize_entitlement_email(u.email), u.created_at DESC
ON CONFLICT (email_key) DO UPDATE
SET
  welcome_granted = public.entitlement_ledger.welcome_granted OR EXCLUDED.welcome_granted,
  welcome_minutes_granted = GREATEST(
    public.entitlement_ledger.welcome_minutes_granted,
    EXCLUDED.welcome_minutes_granted
  ),
  last_user_id = COALESCE(EXCLUDED.last_user_id, public.entitlement_ledger.last_user_id);

DO $$
BEGIN
  UPDATE public.entitlement_ledger el
  SET
    medical_trial_used = true,
    medical_trial_started_at = ma.trial_started_at,
    medical_trial_expires_at = ma.trial_expires_at,
    medical_usage_seconds = ma.current_period_usage_seconds,
    medical_included_seconds = ma.included_seconds,
    medical_subscription_plan = ma.subscription_plan,
    medical_subscription_status = ma.subscription_status,
    medical_billing_cycle_started_at = ma.billing_cycle_started_at,
    medical_billing_cycle_ends_at = ma.billing_cycle_ends_at
  FROM public.medical_accounts ma
  JOIN auth.users u ON u.id = ma.user_id
  WHERE el.email_key = public.normalize_entitlement_email(u.email);

  INSERT INTO public.entitlement_ledger (
    email_key,
    medical_trial_used,
    medical_trial_started_at,
    medical_trial_expires_at,
    medical_usage_seconds,
    medical_included_seconds,
    medical_subscription_plan,
    medical_subscription_status,
    medical_billing_cycle_started_at,
    medical_billing_cycle_ends_at,
    last_user_id
  )
  SELECT
    public.normalize_entitlement_email(u.email),
    true,
    ma.trial_started_at,
    ma.trial_expires_at,
    ma.current_period_usage_seconds,
    ma.included_seconds,
    ma.subscription_plan,
    ma.subscription_status,
    ma.billing_cycle_started_at,
    ma.billing_cycle_ends_at,
    u.id
  FROM public.medical_accounts ma
  JOIN auth.users u ON u.id = ma.user_id
  WHERE public.normalize_entitlement_email(u.email) <> ''
  ON CONFLICT (email_key) DO UPDATE
  SET
    medical_trial_used = true,
    medical_trial_started_at = COALESCE(
      public.entitlement_ledger.medical_trial_started_at,
      EXCLUDED.medical_trial_started_at
    ),
    medical_trial_expires_at = COALESCE(
      public.entitlement_ledger.medical_trial_expires_at,
      EXCLUDED.medical_trial_expires_at
    ),
    medical_usage_seconds = COALESCE(
      public.entitlement_ledger.medical_usage_seconds,
      EXCLUDED.medical_usage_seconds
    ),
    medical_included_seconds = COALESCE(
      public.entitlement_ledger.medical_included_seconds,
      EXCLUDED.medical_included_seconds
    ),
    medical_subscription_plan = COALESCE(
      public.entitlement_ledger.medical_subscription_plan,
      EXCLUDED.medical_subscription_plan
    ),
    medical_subscription_status = COALESCE(
      public.entitlement_ledger.medical_subscription_status,
      EXCLUDED.medical_subscription_status
    );
EXCEPTION
  WHEN undefined_table THEN
    NULL;
END $$;

ALTER TABLE public.entitlement_ledger ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS entitlement_ledger_no_direct ON public.entitlement_ledger;

-- No policies for anon/authenticated: only service_role / security definer functions.
NOTIFY pgrst, 'reload schema';
