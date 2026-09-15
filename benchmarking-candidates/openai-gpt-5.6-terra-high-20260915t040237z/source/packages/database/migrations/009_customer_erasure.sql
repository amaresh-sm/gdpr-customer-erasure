CREATE TABLE IF NOT EXISTS customers.erasure_requests(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL,
  customer_id uuid NOT NULL REFERENCES customers.customers(id),
  status text NOT NULL CHECK(status IN ('pending','processing','failed','completed')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(merchant_id,customer_id)
);

CREATE TABLE IF NOT EXISTS customers.erasure_idempotency_keys(
  merchant_id uuid NOT NULL,
  key text NOT NULL CHECK(char_length(key) BETWEEN 8 AND 200),
  customer_id uuid NOT NULL,
  request_id uuid NOT NULL REFERENCES customers.erasure_requests(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(merchant_id,key)
);

CREATE INDEX IF NOT EXISTS erasure_requests_runnable
  ON customers.erasure_requests(status,updated_at) WHERE status='pending';

CREATE TABLE IF NOT EXISTS customers.erasure_tombstones(
  merchant_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  email_hmac text NOT NULL,
  external_reference_hmac text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(merchant_id,customer_id),
  UNIQUE(merchant_id,email_hmac),
  UNIQUE(merchant_id,external_reference_hmac)
);

ALTER TABLE payments.payment_intents ALTER COLUMN customer_id DROP NOT NULL;
ALTER TABLE payments.payment_intents ALTER COLUMN payment_method_id DROP NOT NULL;
ALTER TABLE payments.invoices ALTER COLUMN customer_id DROP NOT NULL;
