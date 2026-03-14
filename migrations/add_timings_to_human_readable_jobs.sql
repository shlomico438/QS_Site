-- human_readable_jobs: no trigger_sec, download_sec at end.
-- Run in Supabase SQL Editor.

DROP VIEW IF EXISTS public.human_readable_jobs;

CREATE VIEW public.human_readable_jobs
WITH (security_invoker = on)
AS
SELECT
  ROW_NUMBER() OVER (ORDER BY j.created_at DESC) - 1 AS idx,
  j.user_name,
  j.user_email,
  j.created_at AS created_timestamp,
  j.type,
  j.status,
  ROUND(j.runpod_wakeup_sec)::int AS runpod_wakeup_sec,
  ROUND(j.runpod_process_sec)::int AS runpod_process_sec,
  ROUND(j.gpt_sec)::int AS gpt_sec,
  ROUND(j.total_sec)::int AS total_sec,
  ROUND(j.download_sec)::int AS download_sec
FROM public.jobs j;
