CREATE SCHEMA IF NOT EXISTS privacy;

CREATE TABLE IF NOT EXISTS privacy.erasure_requests(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','failed','completed')),
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

CREATE TABLE IF NOT EXISTS privacy.erasure_steps(
  request_id uuid NOT NULL REFERENCES privacy.erasure_requests(id),
  step text NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(request_id,step)
);

/*
 * Tombstone of erased subjects. This is the only record kept about a deleted
 * customer: it carries no personal data, it stops replayed events, retried jobs
 * and late provider callbacks from recreating the subject, and it keeps a repeated
 * deletion request converging on the same result.
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
