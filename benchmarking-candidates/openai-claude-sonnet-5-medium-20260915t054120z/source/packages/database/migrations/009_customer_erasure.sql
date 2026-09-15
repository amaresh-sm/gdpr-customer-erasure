CREATE TABLE IF NOT EXISTS customers.erasure_requests(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','completed','failed')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  locked_by text,
  locked_at timestamptz,
  lease_expires_at timestamptz,
  available_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(merchant_id,customer_id)
);

CREATE INDEX IF NOT EXISTS erasure_requests_runnable
  ON customers.erasure_requests(status,available_at)
  WHERE status IN ('pending','failed');

CREATE INDEX IF NOT EXISTS erasure_requests_lease_recovery
  ON customers.erasure_requests(status,lease_expires_at)
  WHERE status='processing';

CREATE TABLE IF NOT EXISTS customers.erasure_idempotency_keys(
  merchant_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  customer_id uuid NOT NULL,
  erasure_request_id uuid NOT NULL REFERENCES customers.erasure_requests(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(merchant_id,idempotency_key)
);
