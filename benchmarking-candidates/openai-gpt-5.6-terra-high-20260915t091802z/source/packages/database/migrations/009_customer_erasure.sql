CREATE TABLE IF NOT EXISTS operations.customer_erasure_requests(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK(char_length(idempotency_key) BETWEEN 8 AND 200),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','failed','completed')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  locked_by text,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(merchant_id, customer_id),
  UNIQUE(merchant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS customer_erasure_requests_runnable
  ON operations.customer_erasure_requests(status, lease_expires_at, updated_at);
