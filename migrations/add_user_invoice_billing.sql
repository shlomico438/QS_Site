-- Invoice billing details per user (ת.ז./ח.פ. + city) for Cardcom documents.
-- Synced across devices when the same account signs in.

ALTER TABLE public.user_credits
  ADD COLUMN IF NOT EXISTS invoice_tax_id text,
  ADD COLUMN IF NOT EXISTS invoice_city text;

COMMENT ON COLUMN public.user_credits.invoice_tax_id IS 'Israeli ID or company number for Cardcom tax invoice.';
COMMENT ON COLUMN public.user_credits.invoice_city IS 'City (ישוב) for Cardcom tax invoice.';

NOTIFY pgrst, 'reload schema';
