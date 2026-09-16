-- Tracks merchant-initiated requests to erase a customer's personal data and
-- resumable worker progress. Only one workflow may ever exist per customer:
-- the unique constraint below is what lets the API return an existing
-- request instead of starting a duplicate erasure for the same customer.
CREATE TABLE IF NOT EXISTS customers.erasure_requests(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL,
  customer_id uuid NOT NULL REFERENCES customers.customers(id),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','failed','completed')),
  attempts integer NOT NULL DEFAULT 0,
  -- Email addresses captured at request time so Mailpit cleanup can still
  -- find the customer's mail after the customer row itself is anonymized.
  -- Cleared once the request completes so no ordinary record keeps them.
  target_emails text[] NOT NULL DEFAULT '{}',
  locked_by text,
  locked_at timestamptz,
  lease_expires_at timestamptz,
  available_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(merchant_id,customer_id)
);

CREATE INDEX IF NOT EXISTS erasure_requests_runnable
  ON customers.erasure_requests(status,available_at)
  WHERE status IN ('pending','failed');

CREATE INDEX IF NOT EXISTS erasure_requests_lease_recovery
  ON customers.erasure_requests(status,lease_expires_at)
  WHERE status = 'processing';

-- Customer imports have never recorded which customer they describe, which
-- makes their stored artifacts impossible to find during erasure. Track it
-- going forward so erasure can locate and remove import artifacts.
ALTER TABLE customers.customer_imports
  ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES customers.customers(id);

CREATE INDEX IF NOT EXISTS customer_imports_by_customer
  ON customers.customer_imports(merchant_id,customer_id)
  WHERE customer_id IS NOT NULL;
