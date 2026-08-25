CREATE TABLE IF NOT EXISTS customers.provider_customer_mappings(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL,
  customer_id uuid NOT NULL REFERENCES customers.customers(id),
  provider_name text NOT NULL,
  provider_customer_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(merchant_id,customer_id,provider_name),
  UNIQUE(provider_name,provider_customer_id)
);

CREATE INDEX IF NOT EXISTS provider_customer_mappings_customer
  ON customers.provider_customer_mappings(merchant_id,customer_id);

CREATE TABLE IF NOT EXISTS provider_sandbox.customers(
  id text PRIMARY KEY,
  merchant_id uuid NOT NULL,
  payflow_customer_id uuid NOT NULL,
  email text NOT NULL,
  name text NOT NULL,
  external_reference text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS provider_sandbox_customers_payflow_customer
  ON provider_sandbox.customers(merchant_id,payflow_customer_id);

ALTER TABLE provider_sandbox.payment_intents
  ADD COLUMN IF NOT EXISTS provider_customer_id text;
