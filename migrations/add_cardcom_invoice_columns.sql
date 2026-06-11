-- Optional invoice metadata from Cardcom DocumentInfo (LowProfile/GetLpResult).
-- Apply after add_cardcom_credit_purchases.sql if you enable CARDCOM_INVOICES.

ALTER TABLE public.cardcom_credit_purchases
  ADD COLUMN IF NOT EXISTS invoice_number text,
  ADD COLUMN IF NOT EXISTS invoice_type text,
  ADD COLUMN IF NOT EXISTS invoice_url text;

COMMENT ON COLUMN public.cardcom_credit_purchases.invoice_number IS 'Cardcom DocumentNumber (e.g. tax invoice + receipt).';
COMMENT ON COLUMN public.cardcom_credit_purchases.invoice_type IS 'Cardcom DocumentType (e.g. TaxInvoiceAndReceipt).';
COMMENT ON COLUMN public.cardcom_credit_purchases.invoice_url IS 'Cardcom document link when returned by API.';
