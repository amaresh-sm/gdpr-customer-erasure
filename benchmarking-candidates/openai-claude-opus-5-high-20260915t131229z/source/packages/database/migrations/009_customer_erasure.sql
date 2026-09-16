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

CREATE INDEX IF NOT EXISTS erasure_requests_runnable
  ON privacy.erasure_requests(status,available_at,created_at);
CREATE INDEX IF NOT EXISTS erasure_requests_lease_recovery
  ON privacy.erasure_requests(status,lease_expires_at)
  WHERE status='processing';

CREATE TABLE IF NOT EXISTS privacy.erasure_request_steps(
  request_id uuid NOT NULL REFERENCES privacy.erasure_requests(id),
  step text NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(request_id,step)
);

/*
 * Minimal retained deletion record. It holds no personal data: the customer
 * identifier is kept so that delayed work, replayed events, and provider
 * callbacks can recognise an erased subject and refuse to recreate its data.
 */
CREATE TABLE IF NOT EXISTS privacy.erased_customers(
  merchant_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  request_id uuid NOT NULL REFERENCES privacy.erasure_requests(id),
  suppressed_at timestamptz NOT NULL DEFAULT now(),
  erased_at timestamptz,
  PRIMARY KEY(merchant_id,customer_id)
);

CREATE OR REPLACE FUNCTION privacy.is_pii_key(key text) RETURNS boolean AS $$
  SELECT lower(key) IN (
    'email','emails','customeremail','customer_email','destination','destinations','recipient','to',
    'name','customername','customer_name','displayname','display_name','billingname','billing_name',
    'firstname','first_name','lastname','last_name','fullname','full_name',
    'phone','phonenumber','phone_number','mobile',
    'address','addresses','billingaddress','billing_address','shippingaddress','shipping_address',
    'line1','line2','city','region','state','postalcode','postal_code','zip','country',
    'externalreference','external_reference','metadata','properties',
    'customer','customersnapshot','customer_snapshot','billingsnapshot','billing_snapshot',
    'contact','contacts','body','textbody','text_body','htmlbody','html_body','subject','value','notes','note',
    'last4','brand','providertoken','provider_token','ip','ipaddress','ip_address','anonymousid','anonymous_id'
  );
$$ LANGUAGE sql IMMUTABLE;

/*
 * Recursively drops the values of personal-data keys while preserving document
 * shape, identifiers, and monetary facts so retained records stay meaningful.
 */
CREATE OR REPLACE FUNCTION privacy.redact_pii(document jsonb) RETURNS jsonb AS $$
DECLARE
  result jsonb;
  entry record;
BEGIN
  IF document IS NULL THEN RETURN NULL; END IF;

  IF jsonb_typeof(document) = 'object' THEN
    result := '{}'::jsonb;
    FOR entry IN SELECT key, value FROM jsonb_each(document) LOOP
      IF privacy.is_pii_key(entry.key) THEN
        result := result || jsonb_build_object(entry.key, 'null'::jsonb);
      ELSE
        result := result || jsonb_build_object(entry.key, privacy.redact_pii(entry.value));
      END IF;
    END LOOP;
    RETURN result;
  END IF;

  IF jsonb_typeof(document) = 'array' THEN
    RETURN COALESCE(
      (SELECT jsonb_agg(privacy.redact_pii(element) ORDER BY ordinality)
       FROM jsonb_array_elements(document) WITH ORDINALITY AS elements(element, ordinality)),
      '[]'::jsonb
    );
  END IF;

  RETURN document;
END;
$$ LANGUAGE plpgsql IMMUTABLE;
