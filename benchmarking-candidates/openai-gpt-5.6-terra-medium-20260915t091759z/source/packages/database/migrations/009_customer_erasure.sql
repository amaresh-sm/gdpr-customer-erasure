CREATE TABLE IF NOT EXISTS operations.customer_erasure_requests(
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
  UNIQUE(merchant_id,customer_id),
  UNIQUE(merchant_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS customer_erasure_requests_runnable
  ON operations.customer_erasure_requests(status,updated_at)
  WHERE status IN ('pending','failed');
