-- Renewals must be idempotent per period being closed (cycle end), not cycle start.
-- Successful charges used to rewrite billing_cycle_started_at to the *new* cycle,
-- which then blocked the next month's insert (same start as the account).
DROP INDEX IF EXISTS public.uq_medical_renewal_cycle;

CREATE UNIQUE INDEX uq_medical_renewal_cycle
  ON public.medical_subscription_payments (user_id, payment_kind, billing_cycle_ends_at)
  WHERE payment_kind = 'renewal'
    AND status IN ('pending', 'paid')
    AND billing_cycle_ends_at IS NOT NULL;

COMMENT ON INDEX public.uq_medical_renewal_cycle IS
  'One pending/paid medical renewal per user per closed billing-cycle end; failed rows may be retried.';
