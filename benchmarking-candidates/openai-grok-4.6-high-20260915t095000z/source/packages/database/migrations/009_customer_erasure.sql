CREATE TABLE IF NOT EXISTS operations.erasure_requests(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','processing','failed','completed')),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 8,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_by text,
  locked_at timestamptz,
  lease_expires_at timestamptz,
  subject_emails text[] NOT NULL DEFAULT '{}',
  UNIQUE(merchant_id, customer_id)
);

CREATE INDEX IF NOT EXISTS erasure_requests_runnable
  ON operations.erasure_requests(status, next_attempt_at, created_at);

CREATE INDEX IF NOT EXISTS erasure_requests_by_merchant
  ON operations.erasure_requests(merchant_id, id);

CREATE TABLE IF NOT EXISTS operations.erasure_tombstones(
  merchant_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  erasure_request_id uuid NOT NULL REFERENCES operations.erasure_requests(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(merchant_id, customer_id)
);

CREATE INDEX IF NOT EXISTS erasure_tombstones_request
  ON operations.erasure_tombstones(erasure_request_id);

ALTER TABLE customers.customer_imports
  ADD COLUMN IF NOT EXISTS customer_id uuid;
