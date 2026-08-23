CREATE SCHEMA IF NOT EXISTS provider_sandbox;

CREATE TABLE IF NOT EXISTS provider_sandbox.payment_intents(
  id text PRIMARY KEY,
  payment_id uuid NOT NULL UNIQUE,
  merchant_id uuid NOT NULL,
  amount bigint NOT NULL CHECK(amount > 0),
  currency char(3) NOT NULL,
  payment_method_id uuid NOT NULL,
  webhook_url text NOT NULL,
  status text NOT NULL CHECK(status IN ('processing','succeeded','failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS provider_sandbox.refunds(
  id text PRIMARY KEY,
  provider_payment_id text NOT NULL REFERENCES provider_sandbox.payment_intents(id),
  refund_id uuid NOT NULL UNIQUE,
  merchant_id uuid NOT NULL,
  amount bigint NOT NULL CHECK(amount > 0),
  currency char(3) NOT NULL,
  reason text NOT NULL,
  status text NOT NULL CHECK(status IN ('pending','succeeded','failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sandbox_payments_by_merchant
  ON provider_sandbox.payment_intents(merchant_id,status,created_at);
