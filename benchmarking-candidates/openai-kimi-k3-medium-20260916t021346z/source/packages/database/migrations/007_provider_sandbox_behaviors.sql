ALTER TABLE provider_sandbox.payment_intents
  ADD COLUMN IF NOT EXISTS outcome text NOT NULL DEFAULT 'succeeded'
    CHECK(outcome IN ('succeeded','declined','timeout')),
  ADD COLUMN IF NOT EXISTS delivery_mode text NOT NULL DEFAULT 'standard'
    CHECK(delivery_mode IN ('standard','duplicate','stale_processing')),
  ADD COLUMN IF NOT EXISTS failure_code text;
