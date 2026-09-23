-- Marketing opt-out list. Export + SES skip these addresses.
-- Apply in Supabase Dashboard → SQL Editor.
--
-- Add someone:
--   INSERT INTO public.unsubscribed_emails (email, note)
--   VALUES ('user@example.com', 'asked to stop emails')
--   ON CONFLICT (email) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.unsubscribed_emails (
  email text PRIMARY KEY,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT unsubscribed_emails_format CHECK (position('@' in email) > 1)
);

COMMENT ON TABLE public.unsubscribed_emails IS
  'Emails excluded from marketing CSV exports and SES campaigns.';
COMMENT ON COLUMN public.unsubscribed_emails.email IS
  'Lowercased, trimmed address. Matched case-insensitively by export scripts.';

CREATE OR REPLACE FUNCTION public.normalize_unsubscribed_email()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.email := lower(btrim(COALESCE(NEW.email, '')));
  IF NEW.email = '' OR position('@' in NEW.email) <= 1 THEN
    RAISE EXCEPTION 'unsubscribed_emails.email must be a valid email';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_unsubscribed_emails_normalize ON public.unsubscribed_emails;
CREATE TRIGGER trg_unsubscribed_emails_normalize
BEFORE INSERT OR UPDATE ON public.unsubscribed_emails
FOR EACH ROW
EXECUTE FUNCTION public.normalize_unsubscribed_email();

ALTER TABLE public.unsubscribed_emails ENABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
