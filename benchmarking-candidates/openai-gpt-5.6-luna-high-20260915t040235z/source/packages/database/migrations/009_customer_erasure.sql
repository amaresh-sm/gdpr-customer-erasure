CREATE TABLE IF NOT EXISTS operations.erasure_requests(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL CHECK(status IN ('pending','processing','failed','completed')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  object_keys text[] NOT NULL DEFAULT '{}',
  scrubbed_at timestamptz,
  completed_at timestamptz,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(merchant_id,idempotency_key),
  UNIQUE(merchant_id,customer_id)
);

CREATE INDEX IF NOT EXISTS erasure_requests_runnable
  ON operations.erasure_requests(status,lease_expires_at,created_at);

ALTER TABLE payments.payment_intents
  ALTER COLUMN customer_id DROP NOT NULL,
  ALTER COLUMN payment_method_id DROP NOT NULL;

ALTER TABLE payments.invoices
  ALTER COLUMN customer_id DROP NOT NULL;

ALTER TABLE customers.customer_imports
  ADD COLUMN IF NOT EXISTS customer_id uuid;

