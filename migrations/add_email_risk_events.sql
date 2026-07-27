-- Signup email risk scoring audit log (domain only — no full email addresses).
-- Apply in Supabase Dashboard → SQL Editor.

CREATE TABLE IF NOT EXISTS public.email_risk_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_domain text NOT NULL,
  risk_score integer NOT NULL,
  reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  domain_age_days integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.email_risk_events IS 'Signup email risk checks (disposable domain / RDAP domain age). Stores domain only.';
COMMENT ON COLUMN public.email_risk_events.email_domain IS 'Lowercase email domain from signup attempt (no local part).';
COMMENT ON COLUMN public.email_risk_events.reasons IS 'JSON array of risk reason codes.';

CREATE INDEX IF NOT EXISTS idx_email_risk_events_created_at
  ON public.email_risk_events (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_email_risk_events_domain
  ON public.email_risk_events (email_domain);

ALTER TABLE public.email_risk_events ENABLE ROW LEVEL SECURITY;

-- Inserts via service role only (Flask backend). No client policies.

NOTIFY pgrst, 'reload schema';
