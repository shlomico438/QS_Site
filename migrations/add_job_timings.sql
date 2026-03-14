-- Add PROCESS TIMING columns to jobs table for human-readable display.
-- Run this in Supabase SQL Editor or via psql.

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS runpod_job_id text,
  ADD COLUMN IF NOT EXISTS trigger_sec real,
  ADD COLUMN IF NOT EXISTS download_sec real,
  ADD COLUMN IF NOT EXISTS runpod_wakeup_sec real,
  ADD COLUMN IF NOT EXISTS runpod_process_sec real,
  ADD COLUMN IF NOT EXISTS gpt_sec real,
  ADD COLUMN IF NOT EXISTS total_sec real;

-- Optional: index for lookups when gpu_callback updates by runpod_job_id
CREATE INDEX IF NOT EXISTS idx_jobs_runpod_job_id ON jobs (runpod_job_id) WHERE runpod_job_id IS NOT NULL;
