CREATE TABLE IF NOT EXISTS customers.erasure_requests(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','failed','completed')),
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  last_error text,
  UNIQUE(merchant_id,idempotency_key),
  UNIQUE(merchant_id,customer_id)
);
CREATE INDEX IF NOT EXISTS erasure_requests_status ON customers.erasure_requests(status,updated_at);
ALTER TABLE operations.jobs ADD COLUMN IF NOT EXISTS erasure_request_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS erasure_request_jobs ON operations.jobs(erasure_request_id) WHERE erasure_request_id IS NOT NULL;
