-- Store Cardcom / charge failure details on medical payments for ops debugging.
ALTER TABLE public.medical_subscription_payments
  ADD COLUMN IF NOT EXISTS failure_reason text;

COMMENT ON COLUMN public.medical_subscription_payments.failure_reason IS
  'Last charge failure detail (e.g. Cardcom ResponseCode + Description). Cleared conceptually when a new paid row is created.';
