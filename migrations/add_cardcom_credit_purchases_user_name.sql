-- Display name on Cardcom credit purchases (admin / support).
-- Apply after add_cardcom_credit_purchases.sql.
-- Backfilled from user_credits.user_name, then auth.users metadata.

ALTER TABLE public.cardcom_credit_purchases
  ADD COLUMN IF NOT EXISTS user_name text;

COMMENT ON COLUMN public.cardcom_credit_purchases.user_name IS
  'User display name at purchase time (from auth profile metadata).';

UPDATE public.cardcom_credit_purchases p
SET user_name = NULLIF(trim(uc.user_name), '')
FROM public.user_credits uc
WHERE p.user_id = uc.user_id
  AND NULLIF(trim(uc.user_name), '') IS NOT NULL
  AND (p.user_name IS NULL OR trim(p.user_name) = '');

UPDATE public.cardcom_credit_purchases p
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
WHERE p.user_id = sub.user_id
  AND sub.display_name IS NOT NULL
  AND sub.display_name <> ''
  AND (p.user_name IS NULL OR trim(p.user_name) = '');

NOTIFY pgrst, 'reload schema';
