-- Doctor-specific medical prompt training.
-- Run in Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS public.doctor_prompt_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'disabled' CHECK (status IN ('training', 'active', 'disabled')),
  active_prompt text,
  candidate_prompt text,
  base_prompt_version text NOT NULL DEFAULT 'medical_task2_v1',
  optimizer_model text,
  preview_model text,
  version integer NOT NULL DEFAULT 1,
  examples_count integer NOT NULL DEFAULT 0,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id)
);

CREATE TABLE IF NOT EXISTS public.doctor_prompt_training_examples (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  profile_id uuid REFERENCES public.doctor_prompt_profiles(id) ON DELETE SET NULL,
  transcript_ref text,
  transcript_excerpt text,
  ai_summary jsonb,
  doctor_summary text,
  candidate_prompt text,
  candidate_preview jsonb,
  accepted boolean NOT NULL DEFAULT false,
  optimizer_model text,
  preview_model text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.doctor_prompt_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.doctor_prompt_training_examples ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS doctor_prompt_profiles_select_own ON public.doctor_prompt_profiles;
CREATE POLICY doctor_prompt_profiles_select_own
ON public.doctor_prompt_profiles
FOR SELECT
USING (auth.uid() = user_id);

DROP POLICY IF EXISTS doctor_prompt_profiles_insert_own ON public.doctor_prompt_profiles;
CREATE POLICY doctor_prompt_profiles_insert_own
ON public.doctor_prompt_profiles
FOR INSERT
WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS doctor_prompt_profiles_update_own ON public.doctor_prompt_profiles;
CREATE POLICY doctor_prompt_profiles_update_own
ON public.doctor_prompt_profiles
FOR UPDATE
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS doctor_prompt_examples_select_own ON public.doctor_prompt_training_examples;
CREATE POLICY doctor_prompt_examples_select_own
ON public.doctor_prompt_training_examples
FOR SELECT
USING (auth.uid() = user_id);

DROP POLICY IF EXISTS doctor_prompt_examples_insert_own ON public.doctor_prompt_training_examples;
CREATE POLICY doctor_prompt_examples_insert_own
ON public.doctor_prompt_training_examples
FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_doctor_prompt_examples_user_created
ON public.doctor_prompt_training_examples (user_id, created_at DESC);
