-- Add PROCESS TIMING columns to jobs table for human-readable display.
--
-- HOW TO APPLY (Supabase):
--   1. Supabase Dashboard → SQL Editor → paste this file → Run.
--   2. Refresh PostgREST schema cache (fixes PGRST204 "Could not find column ... in schema cache"):
--      - Dashboard → Project Settings → API → click "Reload schema" / restart API if available, OR
--      - SQL Editor: run once (if your role allows):
--          NOTIFY pgrst, 'reload schema';
--      - Or wait ~1–2 minutes; PostgREST may auto-reload.
--   3. Re-run your app; _update_job_timings in siteapp.py should stop logging PGRST204 for
--      trigger_completed_at / gpu_started_at.
--
-- If you already ran an earlier version, the ALTER is safe (IF NOT EXISTS).

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS runpod_job_id text,
  ADD COLUMN IF NOT EXISTS trigger_sec real,
  ADD COLUMN IF NOT EXISTS trigger_completed_at real,
  ADD COLUMN IF NOT EXISTS gpu_started_at real,
  ADD COLUMN IF NOT EXISTS download_sec real,
  ADD COLUMN IF NOT EXISTS runpod_wakeup_sec real,
  ADD COLUMN IF NOT EXISTS runpod_process_sec real,
  ADD COLUMN IF NOT EXISTS gpt_sec real,
  ADD COLUMN IF NOT EXISTS gpt_format_sec real,
  ADD COLUMN IF NOT EXISTS total_sec real;

-- Optional: index for lookups when gpu_callback updates by runpod_job_id
CREATE INDEX IF NOT EXISTS idx_jobs_runpod_job_id ON jobs (runpod_job_id) WHERE runpod_job_id IS NOT NULL;
