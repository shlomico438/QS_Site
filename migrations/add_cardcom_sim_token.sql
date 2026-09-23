-- Optional: store simulation checkout token so any ECS task can validate
-- /cardcom/sim-checkout. Safe to skip — insert retries without this column.
ALTER TABLE public.cardcom_credit_purchases
  ADD COLUMN IF NOT EXISTS sim_token text;

COMMENT ON COLUMN public.cardcom_credit_purchases.sim_token IS
  'One-time token for internal CARDCOM_SIMULATION checkout (not used for live Cardcom).';
