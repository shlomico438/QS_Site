-- Persist billable media duration on the jobs row (not in transcript JSON).
-- Apply in Supabase Dashboard → SQL Editor, then reload PostgREST schema:
--   NOTIFY pgrst, 'reload schema';

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS file_duration_sec real;

COMMENT ON COLUMN public.jobs.file_duration_sec IS
  'Uploaded media length in seconds used for credit billing (set as soon as known).';

-- Optional sanity: ignore absurd values at write time in app; DB allows null.
