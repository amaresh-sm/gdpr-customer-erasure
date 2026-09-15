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
  UNIQUE(merchant_id,customer_id)
);

CREATE TABLE IF NOT EXISTS privacy.erasure_idempotency_keys(
  merchant_id uuid NOT NULL,
  key text NOT NULL CHECK(char_length(key) BETWEEN 8 AND 200),
  customer_id uuid NOT NULL,
  request_id uuid NOT NULL REFERENCES privacy.erasure_requests(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(merchant_id,key)
);

CREATE TABLE IF NOT EXISTS privacy.erased_customers(
  merchant_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  erased_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(merchant_id,customer_id)
);

CREATE INDEX IF NOT EXISTS erasure_requests_runnable
  ON privacy.erasure_requests(status,updated_at);
