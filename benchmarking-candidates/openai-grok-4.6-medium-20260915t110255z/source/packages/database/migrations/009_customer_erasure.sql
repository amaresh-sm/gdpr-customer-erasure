CREATE TABLE IF NOT EXISTS operations.erasure_requests(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','failed','completed')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(customer_id)
);

CREATE INDEX IF NOT EXISTS erasure_requests_by_merchant
  ON operations.erasure_requests(merchant_id,created_at DESC);

CREATE TABLE IF NOT EXISTS operations.privacy_tombstones(
  customer_id uuid PRIMARY KEY,
  merchant_id uuid NOT NULL,
  erasure_request_id uuid NOT NULL REFERENCES operations.erasure_requests(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS privacy_tombstones_by_merchant
  ON operations.privacy_tombstones(merchant_id,customer_id);
