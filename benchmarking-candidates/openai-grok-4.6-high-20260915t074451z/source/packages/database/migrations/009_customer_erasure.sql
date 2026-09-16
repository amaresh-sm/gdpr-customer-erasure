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
  UNIQUE(merchant_id, customer_id)
);

CREATE TABLE IF NOT EXISTS customers.erasure_tombstones(
  merchant_id uuid NOT NULL,
  customer_id uuid NOT NULL REFERENCES customers.customers(id),
  erasure_request_id uuid NOT NULL REFERENCES customers.erasure_requests(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(merchant_id, customer_id)
);

CREATE INDEX IF NOT EXISTS erasure_requests_runnable
  ON customers.erasure_requests(status, updated_at, created_at)
  WHERE status IN ('pending','failed','processing');

CREATE INDEX IF NOT EXISTS erasure_requests_by_merchant
  ON customers.erasure_requests(merchant_id, id);
