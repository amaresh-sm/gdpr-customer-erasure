CREATE TABLE IF NOT EXISTS customers.erasure_requests(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL CHECK(status IN ('pending','processing','failed','completed')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(merchant_id, customer_id),
  UNIQUE(merchant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS erasure_requests_runnable
  ON customers.erasure_requests(status, updated_at)
  WHERE status IN ('pending', 'failed');

CREATE INDEX IF NOT EXISTS erasure_requests_customer
  ON customers.erasure_requests(merchant_id, customer_id);
