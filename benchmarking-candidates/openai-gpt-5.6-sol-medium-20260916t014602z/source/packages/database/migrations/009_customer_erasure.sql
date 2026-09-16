ALTER TABLE payments.payment_intents ALTER COLUMN customer_id DROP NOT NULL;
ALTER TABLE payments.payment_intents ALTER COLUMN payment_method_id DROP NOT NULL;
ALTER TABLE payments.payment_intents ADD COLUMN IF NOT EXISTS retained_subject_id uuid;
ALTER TABLE payments.invoices ALTER COLUMN customer_id DROP NOT NULL;
ALTER TABLE payments.invoices ADD COLUMN IF NOT EXISTS retained_subject_id uuid;
ALTER TABLE operations.notifications ALTER COLUMN customer_id DROP NOT NULL;
ALTER TABLE operations.document_manifests ALTER COLUMN customer_id DROP NOT NULL;
ALTER TABLE operations.email_deliveries ALTER COLUMN customer_id DROP NOT NULL;
ALTER TABLE provider_sandbox.customers ALTER COLUMN payflow_customer_id DROP NOT NULL;
ALTER TABLE provider_sandbox.payment_intents ALTER COLUMN payment_method_id DROP NOT NULL;

CREATE TABLE IF NOT EXISTS customers.erasure_requests(
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
  cleanup_targets jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(merchant_id,customer_id)
);

CREATE TABLE IF NOT EXISTS customers.erasure_idempotency_keys(
  merchant_id uuid NOT NULL,
  key text NOT NULL,
  customer_id uuid NOT NULL,
  request_id uuid NOT NULL REFERENCES customers.erasure_requests(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(merchant_id,key)
);

CREATE TABLE IF NOT EXISTS customers.erasure_tombstones(
  merchant_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  request_id uuid NOT NULL REFERENCES customers.erasure_requests(id),
  erased_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(merchant_id,customer_id)
);

CREATE INDEX IF NOT EXISTS erasure_requests_runnable
  ON customers.erasure_requests(status,available_at,created_at)
  WHERE status IN ('pending','failed');
CREATE INDEX IF NOT EXISTS erasure_requests_lease_recovery
  ON customers.erasure_requests(status,lease_expires_at)
  WHERE status='processing';
