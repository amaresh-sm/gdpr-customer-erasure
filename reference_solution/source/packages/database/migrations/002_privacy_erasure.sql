CREATE SCHEMA IF NOT EXISTS privacy;

CREATE TABLE IF NOT EXISTS privacy.erasure_requests(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  surrogate_id uuid NOT NULL DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','failed','completed')),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 8,
  subject_context jsonb NOT NULL,
  last_error text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  UNIQUE(merchant_id,customer_id),
  UNIQUE(merchant_id,idempotency_key)
);

CREATE TABLE IF NOT EXISTS privacy.erasure_steps(
  request_id uuid NOT NULL REFERENCES privacy.erasure_requests(id) ON DELETE CASCADE,
  participant text NOT NULL,
  ordinal integer NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','failed','completed')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(request_id,participant),
  UNIQUE(request_id,ordinal)
);

CREATE TABLE IF NOT EXISTS privacy.erased_subjects(
  merchant_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  surrogate_id uuid NOT NULL,
  erasure_request_id uuid NOT NULL REFERENCES privacy.erasure_requests(id),
  erased_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(merchant_id,customer_id),
  UNIQUE(merchant_id,surrogate_id)
);

CREATE INDEX IF NOT EXISTS erasure_requests_runnable
  ON privacy.erasure_requests(status,next_attempt_at,created_at);

UPDATE platform.api_keys
SET scopes=array_append(scopes,'privacy:erase')
WHERE NOT scopes @> ARRAY['privacy:erase'];
