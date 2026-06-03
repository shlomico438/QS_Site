-- User transcription credits (minutes wallet).
-- Apply in Supabase Dashboard → SQL Editor.
--
-- Grants 60 welcome minutes to every existing user and auto-grants 60 minutes
-- to each new auth.users row via trigger.

CREATE TABLE IF NOT EXISTS public.user_credits (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  credit_minutes integer NOT NULL DEFAULT 0 CHECK (credit_minutes >= 0),
  welcome_granted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.user_credits IS 'Per-user transcription credit balance in minutes.';
COMMENT ON COLUMN public.user_credits.credit_minutes IS 'Remaining transcription minutes in the user wallet.';
COMMENT ON COLUMN public.user_credits.welcome_granted IS 'True after the one-time welcome pack has been applied.';

-- Optional: track minutes consumed per job (for billing/audit).
ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS credit_minutes_used real;

COMMENT ON COLUMN public.jobs.credit_minutes_used IS 'Transcription minutes charged against the user wallet for this job.';

CREATE OR REPLACE FUNCTION public.set_user_credits_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_user_credits_updated_at ON public.user_credits;
CREATE TRIGGER trg_user_credits_updated_at
BEFORE UPDATE ON public.user_credits
FOR EACH ROW
EXECUTE FUNCTION public.set_user_credits_updated_at();

CREATE OR REPLACE FUNCTION public.grant_welcome_credits(p_user_id uuid, p_minutes integer DEFAULT 60)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.user_credits (user_id, credit_minutes, welcome_granted)
  VALUES (p_user_id, p_minutes, true)
  ON CONFLICT (user_id) DO UPDATE
  SET
    credit_minutes = CASE
      WHEN public.user_credits.welcome_granted THEN public.user_credits.credit_minutes
      ELSE public.user_credits.credit_minutes + EXCLUDED.credit_minutes
    END,
    welcome_granted = public.user_credits.welcome_granted OR EXCLUDED.welcome_granted,
    updated_at = now();
END;
$$;

CREATE OR REPLACE FUNCTION public.handle_new_user_welcome_credits()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.grant_welcome_credits(NEW.id, 60);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created_welcome_credits ON auth.users;
CREATE TRIGGER on_auth_user_created_welcome_credits
AFTER INSERT ON auth.users
FOR EACH ROW
EXECUTE FUNCTION public.handle_new_user_welcome_credits();

-- One-time backfill for users that already exist before this migration.
INSERT INTO public.user_credits (user_id, credit_minutes, welcome_granted)
SELECT u.id, 60, true
FROM auth.users u
LEFT JOIN public.user_credits uc ON uc.user_id = u.id
WHERE uc.user_id IS NULL;

-- Users with a row but no welcome flag yet (partial rollout / manual rows).
UPDATE public.user_credits
SET
  credit_minutes = credit_minutes + 60,
  welcome_granted = true,
  updated_at = now()
WHERE welcome_granted = false;

ALTER TABLE public.user_credits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_credits_select_own ON public.user_credits;
CREATE POLICY user_credits_select_own
ON public.user_credits
FOR SELECT
USING (auth.uid() = user_id);

-- Inserts/updates are performed by SECURITY DEFINER functions and the service role only.

NOTIFY pgrst, 'reload schema';
