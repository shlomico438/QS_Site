-- Standing closing line for a medical user. Apply in Supabase Dashboard -> SQL Editor.
ALTER TABLE public.medical_accounts
  ADD COLUMN IF NOT EXISTS default_signature text NOT NULL DEFAULT '';

COMMENT ON COLUMN public.medical_accounts.default_signature IS
  'Optional standing signature appended by the doctor. Empty hides the pre-session hint.';
