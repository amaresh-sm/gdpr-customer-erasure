CREATE TABLE IF NOT EXISTS operations.email_deliveries(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL,
  customer_id uuid,
  destination text NOT NULL,
  template text NOT NULL,
  subject text NOT NULL,
  text_body text NOT NULL,
  html_body text NOT NULL,
  message_key uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  provider_message_id text,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','delivered','failed','cancelled')),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 8,
  available_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  cancelled_at timestamptz
);

CREATE INDEX IF NOT EXISTS email_deliveries_runnable
  ON operations.email_deliveries(status,available_at,created_at);
CREATE INDEX IF NOT EXISTS email_deliveries_subject
  ON operations.email_deliveries(merchant_id,customer_id,status);
