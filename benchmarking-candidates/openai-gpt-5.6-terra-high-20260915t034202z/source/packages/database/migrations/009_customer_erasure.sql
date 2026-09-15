CREATE TABLE IF NOT EXISTS operations.customer_erasure_requests(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  idempotency_key_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','failed','completed')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(merchant_id,customer_id),
  UNIQUE(merchant_id,idempotency_key_hash)
);

CREATE INDEX IF NOT EXISTS customer_erasure_requests_runnable
  ON operations.customer_erasure_requests(status,updated_at)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS operations.customer_erasure_idempotency_keys(
  merchant_id uuid NOT NULL,
  idempotency_key_hash text NOT NULL,
  customer_id uuid NOT NULL,
  request_id uuid NOT NULL REFERENCES operations.customer_erasure_requests(id),
  PRIMARY KEY(merchant_id,idempotency_key_hash)
);

CREATE TABLE IF NOT EXISTS operations.customer_erasure_tombstones(
  merchant_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  request_id uuid NOT NULL REFERENCES operations.customer_erasure_requests(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(merchant_id,customer_id),
  UNIQUE(request_id)
);

ALTER TABLE customers.customer_imports ADD COLUMN IF NOT EXISTS customer_id uuid;

ALTER TABLE payments.payment_intents
  ALTER COLUMN customer_id DROP NOT NULL,
  ALTER COLUMN payment_method_id DROP NOT NULL;
ALTER TABLE payments.invoices ALTER COLUMN customer_id DROP NOT NULL;
ALTER TABLE provider_sandbox.payment_intents ALTER COLUMN payment_method_id DROP NOT NULL;
