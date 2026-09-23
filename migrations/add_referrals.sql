-- Referral program: unique codes, first-purchase rewards, stored invite emails.
-- Apply in Supabase Dashboard → SQL Editor.
--
-- Query invite copy when sending a campaign:
--   SELECT user_id, code, referral_link, email_subject_he, email_body_he,
--          email_subject_en, email_body_en
--   FROM public.referral_profiles;

CREATE TABLE IF NOT EXISTS public.referral_profiles (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  code text NOT NULL UNIQUE,
  referral_link text NOT NULL,
  email_subject_he text NOT NULL DEFAULT '',
  email_body_he text NOT NULL DEFAULT '',
  email_subject_en text NOT NULL DEFAULT '',
  email_body_en text NOT NULL DEFAULT '',
  created_ip text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT referral_profiles_code_format CHECK (code ~ '^[A-Z0-9]{6,12}$')
);

COMMENT ON TABLE public.referral_profiles IS
  'One unique referral code + ready-to-send invite email per registered user.';
COMMENT ON COLUMN public.referral_profiles.email_body_he IS
  'Hebrew invite email (plain text) including the user unique referral link.';
COMMENT ON COLUMN public.referral_profiles.email_body_en IS
  'English invite email (plain text) including the user unique referral link.';

CREATE INDEX IF NOT EXISTS idx_referral_profiles_code
  ON public.referral_profiles (code);

CREATE TABLE IF NOT EXISTS public.referral_attributions (
  referee_user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  referrer_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  code text NOT NULL,
  referee_email_key text,
  referrer_email_key text,
  referee_ip text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'rewarded', 'rejected', 'revoked')),
  reject_reason text,
  attributed_at timestamptz NOT NULL DEFAULT now(),
  rewarded_at timestamptz,
  reward_order_ref text,
  referrer_minutes integer NOT NULL DEFAULT 0 CHECK (referrer_minutes >= 0),
  referee_minutes integer NOT NULL DEFAULT 0 CHECK (referee_minutes >= 0),
  payment_fingerprint text,
  CONSTRAINT referral_attributions_no_self CHECK (referee_user_id <> referrer_user_id)
);

COMMENT ON TABLE public.referral_attributions IS
  'Referred signup. Minutes are granted only after the referee first paid purchase.';

CREATE INDEX IF NOT EXISTS idx_referral_attributions_referrer
  ON public.referral_attributions (referrer_user_id, status);

CREATE INDEX IF NOT EXISTS idx_referral_attributions_status
  ON public.referral_attributions (status);

CREATE TABLE IF NOT EXISTS public.referral_payment_fingerprints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  fingerprint text NOT NULL,
  provider text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, fingerprint)
);

COMMENT ON TABLE public.referral_payment_fingerprints IS
  'Payment identifiers used to block self-referrals (same card / Stripe fingerprint).';

CREATE INDEX IF NOT EXISTS idx_referral_payment_fingerprints_fp
  ON public.referral_payment_fingerprints (fingerprint);

CREATE OR REPLACE FUNCTION public.set_referral_profiles_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_referral_profiles_updated_at ON public.referral_profiles;
CREATE TRIGGER trg_referral_profiles_updated_at
BEFORE UPDATE ON public.referral_profiles
FOR EACH ROW
EXECUTE FUNCTION public.set_referral_profiles_updated_at();

ALTER TABLE public.referral_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referral_attributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referral_payment_fingerprints ENABLE ROW LEVEL SECURITY;

-- Service role (Site backend) reads/writes these. Authenticated clients do not.

NOTIFY pgrst, 'reload schema';
