-- Fix SECURITY DEFINER on human_readable_jobs view
-- Supabase flagged: views with SECURITY DEFINER bypass RLS of the querying user.
-- This changes the view to SECURITY INVOKER so it runs with the caller's permissions (RLS applies).
-- Requires PostgreSQL 15+. Run in Supabase SQL Editor.

ALTER VIEW IF EXISTS public.human_readable_jobs SET (security_invoker = on);

-- If ALTER fails (e.g. PostgreSQL < 15), recreate the view manually:
-- 1. Get current definition: SELECT pg_get_viewdef('public.human_readable_jobs'::regclass, true);
-- 2. DROP VIEW public.human_readable_jobs;
-- 3. CREATE OR REPLACE VIEW public.human_readable_jobs AS <definition> WITH (security_invoker = on);
