-- Display name on the user wallet row (for admin, billing, support).
-- Backfilled from auth.users metadata; kept in sync via app on sign-in / profile save.

ALTER TABLE public.user_credits
  ADD COLUMN IF NOT EXISTS user_name text;

COMMENT ON COLUMN public.user_credits.user_name IS 'User display name (from auth profile metadata).';

-- Backfill existing rows from auth.users.
UPDATE public.user_credits uc
SET user_name = sub.display_name
FROM (
  SELECT
    u.id AS user_id,
    COALESCE(
      NULLIF(trim(u.raw_user_meta_data->>'full_name'), ''),
      NULLIF(trim(u.raw_user_meta_data->>'name'), ''),
      NULLIF(trim(
        concat_ws(' ',
          NULLIF(trim(u.raw_user_meta_data->>'given_name'), ''),
          NULLIF(trim(u.raw_user_meta_data->>'family_name'), '')
        )
      ), ''),
      NULLIF(trim(u.raw_user_meta_data->>'given_name'), ''),
      initcap(split_part(COALESCE(u.email, ''), '@', 1))
    ) AS display_name
  FROM auth.users u
) sub
WHERE uc.user_id = sub.user_id
  AND sub.display_name IS NOT NULL
  AND sub.display_name <> ''
  AND (uc.user_name IS NULL OR trim(uc.user_name) = '');

CREATE OR REPLACE FUNCTION public._auth_user_display_name(p_user_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT COALESCE(
    NULLIF(trim(u.raw_user_meta_data->>'full_name'), ''),
    NULLIF(trim(u.raw_user_meta_data->>'name'), ''),
    NULLIF(trim(
      concat_ws(' ',
        NULLIF(trim(u.raw_user_meta_data->>'given_name'), ''),
        NULLIF(trim(u.raw_user_meta_data->>'family_name'), '')
      )
    ), ''),
    NULLIF(trim(u.raw_user_meta_data->>'given_name'), ''),
    initcap(split_part(COALESCE(u.email, ''), '@', 1))
  )
  FROM auth.users u
  WHERE u.id = p_user_id;
$$;

CREATE OR REPLACE FUNCTION public.grant_welcome_credits(p_user_id uuid, p_minutes integer DEFAULT 60)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_name text;
BEGIN
  v_name := public._auth_user_display_name(p_user_id);

  INSERT INTO public.user_credits (user_id, credit_minutes, welcome_granted, user_name)
  VALUES (p_user_id, p_minutes, true, v_name)
  ON CONFLICT (user_id) DO UPDATE
  SET
    credit_minutes = CASE
      WHEN public.user_credits.welcome_granted THEN public.user_credits.credit_minutes
      ELSE public.user_credits.credit_minutes + EXCLUDED.credit_minutes
    END,
    welcome_granted = public.user_credits.welcome_granted OR EXCLUDED.welcome_granted,
    user_name = COALESCE(
      NULLIF(trim(EXCLUDED.user_name), ''),
      NULLIF(trim(public.user_credits.user_name), '')
    ),
    updated_at = now();
END;
$$;

NOTIFY pgrst, 'reload schema';
