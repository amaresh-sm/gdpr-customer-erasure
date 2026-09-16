CREATE SCHEMA IF NOT EXISTS privacy;

CREATE TABLE IF NOT EXISTS privacy.erasure_requests(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','processing','failed','completed')),
  completed_steps text[] NOT NULL DEFAULT '{}',
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_by text,
  locked_at timestamptz,
  lease_expires_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(merchant_id,customer_id)
);

CREATE INDEX IF NOT EXISTS erasure_requests_runnable
  ON privacy.erasure_requests(status,available_at,created_at);
CREATE INDEX IF NOT EXISTS erasure_requests_lease_recovery
  ON privacy.erasure_requests(status,lease_expires_at)
  WHERE status='processing';

/*
 * The tombstone is the only place a deleted customer's identifier survives. It is written when the
 * request is accepted so delayed work is blocked before any cleanup starts, and it is never removed:
 * Kafka consumers replay from the beginning of the topic and providers redeliver callbacks, so the
 * guard has to outlive the request itself.
 */
CREATE TABLE IF NOT EXISTS privacy.erased_customers(
  merchant_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  request_id uuid NOT NULL REFERENCES privacy.erasure_requests(id),
  erased_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(merchant_id,customer_id)
);

CREATE INDEX IF NOT EXISTS erased_customers_by_customer
  ON privacy.erased_customers(customer_id);
