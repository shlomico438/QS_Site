-- Contact Sales form submissions (backup when email delivery fails).
-- Apply in Supabase Dashboard → SQL Editor.

CREATE TABLE IF NOT EXISTS public.sales_inquiries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text,
  message text NOT NULL,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  source text NOT NULL DEFAULT 'landing',
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.sales_inquiries IS 'Contact Sales form submissions from the marketing site.';
COMMENT ON COLUMN public.sales_inquiries.source IS 'Form origin, e.g. landing, contact page.';

CREATE INDEX IF NOT EXISTS idx_sales_inquiries_created_at
  ON public.sales_inquiries (created_at DESC);

ALTER TABLE public.sales_inquiries ENABLE ROW LEVEL SECURITY;
