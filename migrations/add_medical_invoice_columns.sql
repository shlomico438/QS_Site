-- Invoice metadata from Cardcom DocumentInfo for medical subscriptions.
-- Apply in Supabase Dashboard -> SQL Editor.

ALTER TABLE public.medical_subscription_payments
  ADD COLUMN IF NOT EXISTS invoice_number text,
  ADD COLUMN IF NOT EXISTS invoice_type text,
  ADD COLUMN IF NOT EXISTS invoice_url text;

COMMENT ON COLUMN public.medical_subscription_payments.invoice_number IS
  'Cardcom DocumentNumber (tax invoice + receipt) emailed to the doctor.';
COMMENT ON COLUMN public.medical_subscription_payments.invoice_type IS
  'Cardcom DocumentType (e.g. TaxInvoiceAndReceipt).';
COMMENT ON COLUMN public.medical_subscription_payments.invoice_url IS
  'Cardcom document PDF/link when returned by the API.';
