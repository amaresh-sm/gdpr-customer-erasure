CREATE TABLE IF NOT EXISTS customers.erasure_requests(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  replacement_id uuid NOT NULL DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','failed','completed')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_by text,
  locked_at timestamptz,
  UNIQUE(merchant_id,customer_id),
  UNIQUE(merchant_id,idempotency_key)
);

CREATE INDEX IF NOT EXISTS erasure_requests_work
  ON customers.erasure_requests(status,next_attempt_at,created_at);

CREATE INDEX IF NOT EXISTS erasure_requests_recovery
  ON customers.erasure_requests(status,locked_at)
  WHERE status = 'processing';

CREATE TABLE IF NOT EXISTS customers.erasure_request_keys(
  merchant_id uuid NOT NULL,
  key text NOT NULL,
  customer_id uuid NOT NULL,
  request_id uuid NOT NULL REFERENCES customers.erasure_requests(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(merchant_id,key)
);
