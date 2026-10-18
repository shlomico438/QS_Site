-- Medical microphone failure events for support and analytics.
-- No audio, transcript, patient data, IP, or raw user-agent.
-- medical_accounts has no org/clinic id, so this table does not either.
-- Apply in Supabase Dashboard → SQL Editor.
--
-- Retention (daily). Rolls rows older than 90 days into medical_mic_events_daily,
-- then deletes them:
--   SELECT public.rollup_medical_mic_events();
-- pg_cron:
--   SELECT cron.schedule(
--     'medical-mic-events-retention',
--     '15 3 * * *',
--     $$SELECT public.rollup_medical_mic_events();$$
--   );
-- System cron:
--   15 3 * * * psql "$DATABASE_URL" -c "SELECT public.rollup_medical_mic_events();"

CREATE TABLE IF NOT EXISTS public.medical_mic_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  cause text NOT NULL CHECK (cause IN (
    'no_mic', 'chrome_block', 'os_block', 'busy', 'hw_mute',
    'dead_device', 'device_lost', 'too_quiet', 'overconstrained'
  )),
  phase text NOT NULL CHECK (phase IN ('start', 'recording')),
  browser_family text NOT NULL CHECK (browser_family IN (
    'chrome', 'edge', 'firefox', 'safari', 'other'
  )),
  os_family text NOT NULL CHECK (os_family IN (
    'windows', 'mac', 'linux', 'ios', 'android', 'other'
  )),
  device_label text CHECK (device_label IS NULL OR char_length(device_label) <= 120),
  recovered boolean NOT NULL DEFAULT false,
  recovery_seconds integer CHECK (recovery_seconds IS NULL OR recovery_seconds >= 0),
  session_id text CHECK (session_id IS NULL OR char_length(session_id) <= 64)
);

COMMENT ON TABLE public.medical_mic_events IS
  'Medical mic failures only. Browser family, OS family, and a short device label. No audio, transcript, patient, IP, or user-agent.';
COMMENT ON COLUMN public.medical_mic_events.session_id IS
  'Opaque id generated in the browser for this page load. Not a visit or patient id.';
COMMENT ON COLUMN public.medical_mic_events.device_label IS
  'Microphone label, at most 120 characters. Not a device id.';

CREATE INDEX IF NOT EXISTS idx_medical_mic_events_user_created
  ON public.medical_mic_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_medical_mic_events_cause_created
  ON public.medical_mic_events (cause, created_at);

CREATE TABLE IF NOT EXISTS public.medical_mic_events_daily (
  date date NOT NULL,
  cause text NOT NULL,
  browser_family text NOT NULL,
  os_family text NOT NULL,
  count integer NOT NULL CHECK (count >= 0),
  recovered_count integer NOT NULL CHECK (recovered_count >= 0),
  avg_recovery_seconds numeric,
  PRIMARY KEY (date, cause, browser_family, os_family)
);

COMMENT ON TABLE public.medical_mic_events_daily IS
  'Daily totals kept after medical_mic_events rows older than 90 days are deleted.';

CREATE OR REPLACE FUNCTION public.rollup_medical_mic_events(
  p_older_than interval DEFAULT interval '90 days'
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  deleted_count integer;
BEGIN
  INSERT INTO public.medical_mic_events_daily (
    date, cause, browser_family, os_family, count, recovered_count, avg_recovery_seconds
  )
  SELECT
    (created_at AT TIME ZONE 'UTC')::date,
    cause,
    browser_family,
    os_family,
    count(*)::integer,
    count(*) FILTER (WHERE recovered)::integer,
    avg(recovery_seconds) FILTER (WHERE recovered)
  FROM public.medical_mic_events
  WHERE created_at < now() - p_older_than
  GROUP BY 1, 2, 3, 4
  ON CONFLICT (date, cause, browser_family, os_family) DO UPDATE
  SET
    count = public.medical_mic_events_daily.count + EXCLUDED.count,
    recovered_count = public.medical_mic_events_daily.recovered_count + EXCLUDED.recovered_count,
    avg_recovery_seconds = CASE
      WHEN (public.medical_mic_events_daily.recovered_count + EXCLUDED.recovered_count) = 0 THEN NULL
      ELSE (
        COALESCE(public.medical_mic_events_daily.avg_recovery_seconds, 0) * public.medical_mic_events_daily.recovered_count
        + COALESCE(EXCLUDED.avg_recovery_seconds, 0) * EXCLUDED.recovered_count
      ) / (public.medical_mic_events_daily.recovered_count + EXCLUDED.recovered_count)
    END;

  DELETE FROM public.medical_mic_events
  WHERE created_at < now() - p_older_than;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

COMMENT ON FUNCTION public.rollup_medical_mic_events(interval) IS
  'Aggregate mic events older than 90 days into medical_mic_events_daily, then delete them. Run daily.';

-- Admin review (service role / SQL editor). There is no in-app admin screen for this.
CREATE OR REPLACE VIEW public.medical_mic_failures_by_cause_30d AS
SELECT cause,
       count(*) AS count,
       count(*) FILTER (WHERE recovered) AS recovered_count
FROM public.medical_mic_events
WHERE created_at >= now() - interval '30 days'
GROUP BY cause
ORDER BY count DESC;

CREATE OR REPLACE VIEW public.medical_mic_top_users_30d AS
SELECT user_id, count(*) AS count
FROM public.medical_mic_events
WHERE created_at >= now() - interval '30 days'
GROUP BY user_id
ORDER BY count DESC
LIMIT 20;

CREATE OR REPLACE VIEW public.medical_mic_failures_by_browser_os_30d AS
SELECT browser_family, os_family, count(*) AS count
FROM public.medical_mic_events
WHERE created_at >= now() - interval '30 days'
GROUP BY browser_family, os_family
ORDER BY count DESC;

CREATE OR REPLACE VIEW public.medical_mic_recovery_rate_30d AS
SELECT
  count(*) AS count,
  count(*) FILTER (WHERE recovered) AS recovered_count,
  round(
    100.0 * count(*) FILTER (WHERE recovered) / NULLIF(count(*), 0),
    1
  ) AS recovery_rate_pct,
  round(avg(recovery_seconds) FILTER (WHERE recovered), 1) AS avg_recovery_seconds
FROM public.medical_mic_events
WHERE created_at >= now() - interval '30 days';

ALTER TABLE public.medical_mic_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.medical_mic_events_daily ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.medical_mic_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.medical_mic_events_daily FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rollup_medical_mic_events(interval) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.medical_mic_failures_by_cause_30d FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.medical_mic_top_users_30d FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.medical_mic_failures_by_browser_os_30d FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.medical_mic_recovery_rate_30d FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.medical_mic_events TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.medical_mic_events_daily TO service_role;
GRANT EXECUTE ON FUNCTION public.rollup_medical_mic_events(interval) TO service_role;
GRANT SELECT ON TABLE public.medical_mic_failures_by_cause_30d TO service_role;
GRANT SELECT ON TABLE public.medical_mic_top_users_30d TO service_role;
GRANT SELECT ON TABLE public.medical_mic_failures_by_browser_os_30d TO service_role;
GRANT SELECT ON TABLE public.medical_mic_recovery_rate_30d TO service_role;
