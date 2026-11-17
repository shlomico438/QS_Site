-- Persist last-4 card digits on each medical subscription payment (initial / renewal).
ALTER TABLE public.medical_subscription_payments
  ADD COLUMN IF NOT EXISTS card_last_four text;

COMMENT ON COLUMN public.medical_subscription_payments.card_last_four IS
  'Last 4 digits of the Cardcom card used for this charge, when Cardcom returned them.';
