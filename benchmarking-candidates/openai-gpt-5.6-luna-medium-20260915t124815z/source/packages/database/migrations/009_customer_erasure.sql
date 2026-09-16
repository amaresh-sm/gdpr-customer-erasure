CREATE TABLE IF NOT EXISTS customers.erasure_requests(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','failed','completed')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(merchant_id, customer_id),
  UNIQUE(merchant_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS erasure_requests_pending ON customers.erasure_requests(status,updated_at);
CREATE TABLE IF NOT EXISTS customers.erased_customers(
  merchant_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  erased_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(merchant_id,customer_id)
);
ALTER TABLE payments.payment_intents ALTER COLUMN customer_id DROP NOT NULL;
ALTER TABLE payments.invoices ALTER COLUMN customer_id DROP NOT NULL;
ALTER TABLE operations.notifications ALTER COLUMN destination DROP NOT NULL;
ALTER TABLE operations.email_deliveries ALTER COLUMN destination DROP NOT NULL;
