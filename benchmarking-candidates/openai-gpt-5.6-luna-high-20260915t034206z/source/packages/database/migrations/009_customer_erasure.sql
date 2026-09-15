CREATE SCHEMA IF NOT EXISTS privacy;

CREATE TABLE IF NOT EXISTS privacy.erasure_requests(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  status text NOT NULL CHECK(status IN ('pending','processing','failed','completed')),
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  last_error text,
  object_keys jsonb NOT NULL DEFAULT '[]',
  UNIQUE(merchant_id,customer_id)
);

CREATE TABLE IF NOT EXISTS privacy.erasure_request_keys(
  merchant_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  request_id uuid NOT NULL REFERENCES privacy.erasure_requests(id),
  request_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(merchant_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS erasure_request_keys_request ON privacy.erasure_request_keys(request_id);
CREATE INDEX IF NOT EXISTS erasure_requests_status ON privacy.erasure_requests(status,updated_at);

ALTER TABLE customers.customer_imports ADD COLUMN IF NOT EXISTS customer_id uuid;
ALTER TABLE payments.payment_intents ALTER COLUMN customer_id DROP NOT NULL;
ALTER TABLE payments.invoices ALTER COLUMN customer_id DROP NOT NULL;
ALTER TABLE provider_sandbox.payment_intents ALTER COLUMN payment_method_id DROP NOT NULL;
