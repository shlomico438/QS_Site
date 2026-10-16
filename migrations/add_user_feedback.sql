-- Post-export / signup feedback. Apply in Supabase Dashboard → SQL Editor.

CREATE TABLE IF NOT EXISTS public.user_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL DEFAULT 'post_export',
  stars integer NOT NULL DEFAULT 0 CHECK (stars >= 0 AND stars <= 5),
  liked text,
  improve text,
  email text,
  name text,
  display_name text,
  is_public boolean NOT NULL DEFAULT false,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

COMMENT ON TABLE public.user_feedback IS
  'Optional product feedback from post-export and signup. improve/email stay private.';
COMMENT ON COLUMN public.user_feedback.is_public IS
  'True when stars>=1 so the review can appear on /reviews for Google.';
COMMENT ON COLUMN public.user_feedback.liked IS 'Public quote when is_public.';
COMMENT ON COLUMN public.user_feedback.improve IS 'Internal only — never shown on the site.';

CREATE INDEX IF NOT EXISTS idx_user_feedback_public_created
  ON public.user_feedback (created_at DESC)
  WHERE is_public;

CREATE INDEX IF NOT EXISTS idx_user_feedback_created_at
  ON public.user_feedback (created_at DESC);

ALTER TABLE public.user_feedback ENABLE ROW LEVEL SECURITY;
-- Site uses the service role. No anon/authenticated policies on purpose
-- (emails and improve text must not be readable from the browser).
