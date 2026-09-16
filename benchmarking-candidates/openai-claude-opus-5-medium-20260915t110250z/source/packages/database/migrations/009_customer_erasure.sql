CREATE SCHEMA IF NOT EXISTS privacy;

CREATE TABLE IF NOT EXISTS privacy.erasure_requests(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES platform.merchants(id),
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

/*
 * Finished cleanup steps, so a resumed request never repeats destructive work. `detail` carries
 * pseudonymous execution plans (object keys) and is cleared when the request completes.
 */
CREATE TABLE IF NOT EXISTS privacy.erasure_steps(
  request_id uuid NOT NULL REFERENCES privacy.erasure_requests(id) ON DELETE CASCADE,
  step text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  completed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(request_id,step)
);

/*
 * Retained deletion record: the pseudonymous identifiers of an erased customer and nothing else.
 * Delayed work (retries, provider callbacks, replayed events) consults this table so it can never
 * recreate the personal data that a completed request removed.
 */
CREATE TABLE IF NOT EXISTS privacy.erased_customers(
  merchant_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  request_id uuid NOT NULL REFERENCES privacy.erasure_requests(id),
  erased_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(merchant_id,customer_id)
);

/*
 * Strips the keys that carry customer identity from a retained event, audit, or webhook payload so
 * the record keeps its operational meaning (identifiers, amounts, currencies) and nothing else.
 */
CREATE OR REPLACE FUNCTION privacy.redact_payload(payload jsonb) RETURNS jsonb AS $$
  SELECT COALESCE(payload, '{}'::jsonb) - ARRAY[
    'email','customerEmail','name','phone','externalReference','metadata','customerSnapshot',
    'billingName','billingAddress','brand','last4','providerToken','destination',
    'subject','body','value','line1','line2','city','region','postalCode','country'
  ] || jsonb_build_object('customerErased', true);
$$ LANGUAGE sql IMMUTABLE;

CREATE INDEX IF NOT EXISTS erasure_requests_runnable
  ON privacy.erasure_requests(available_at,created_at)
  WHERE status IN ('pending','failed');

CREATE INDEX IF NOT EXISTS erasure_requests_lease_recovery
  ON privacy.erasure_requests(lease_expires_at)
  WHERE status='processing';
