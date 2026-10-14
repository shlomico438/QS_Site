-- Failed renewals must not block a later retry for the same billing cycle.
-- Keep uniqueness only for in-flight / successful renewal rows.
DROP INDEX IF EXISTS public.uq_medical_renewal_cycle;

CREATE UNIQUE INDEX uq_medical_renewal_cycle
  ON public.medical_subscription_payments (user_id, payment_kind, billing_cycle_started_at)
  WHERE payment_kind = 'renewal' AND status IN ('pending', 'paid');

COMMENT ON INDEX public.uq_medical_renewal_cycle IS
  'One pending/paid medical renewal per user billing-cycle start; failed rows may be retried.';
