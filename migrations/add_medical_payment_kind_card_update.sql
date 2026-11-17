-- Allow card-update payments (replace saved Cardcom token without changing plan).
ALTER TABLE public.medical_subscription_payments
  DROP CONSTRAINT IF EXISTS medical_subscription_payments_payment_kind_check;

ALTER TABLE public.medical_subscription_payments
  ADD CONSTRAINT medical_subscription_payments_payment_kind_check
  CHECK (payment_kind IN ('initial', 'renewal', 'overage', 'card_update'));

COMMENT ON CONSTRAINT medical_subscription_payments_payment_kind_check
  ON public.medical_subscription_payments IS
  'initial/renewal/overage charges, or card_update for replacing the saved Cardcom token.';
