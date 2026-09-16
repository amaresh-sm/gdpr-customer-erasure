CREATE TABLE IF NOT EXISTS privacy.erasure_request_keys(
  merchant_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  request_id uuid NOT NULL REFERENCES privacy.erasure_requests(id),
  customer_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(merchant_id,idempotency_key)
);
