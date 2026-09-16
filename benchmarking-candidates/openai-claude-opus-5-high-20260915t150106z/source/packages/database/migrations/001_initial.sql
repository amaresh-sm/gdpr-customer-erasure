CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS platform;
CREATE SCHEMA IF NOT EXISTS customers;
CREATE SCHEMA IF NOT EXISTS payments;
CREATE SCHEMA IF NOT EXISTS operations;

CREATE TABLE IF NOT EXISTS platform.merchants(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, status text NOT NULL DEFAULT 'active',
  default_currency char(3) NOT NULL DEFAULT 'USD', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS platform.admins(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid NOT NULL REFERENCES platform.merchants(id),
  email text NOT NULL, display_name text NOT NULL, role text NOT NULL CHECK(role IN ('owner','admin','analyst','support')),
  status text NOT NULL DEFAULT 'active', created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(merchant_id,email)
);
CREATE TABLE IF NOT EXISTS platform.api_keys(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid NOT NULL REFERENCES platform.merchants(id),
  key_hash text UNIQUE NOT NULL, label text NOT NULL, scopes text[] NOT NULL, last_used_at timestamptz,
  revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS platform.audit_logs(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid NOT NULL, actor_type text NOT NULL,
  actor_id text, target_type text NOT NULL, target_id text, action text NOT NULL, metadata jsonb NOT NULL DEFAULT '{}',
  correlation_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS customers.customers(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid NOT NULL, external_reference text NOT NULL,
  email text NOT NULL, name text NOT NULL, phone text, status text NOT NULL DEFAULT 'active', metadata jsonb NOT NULL DEFAULT '{}',
  version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(merchant_id,external_reference), UNIQUE(merchant_id,email)
);
CREATE TABLE IF NOT EXISTS customers.addresses(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid NOT NULL, customer_id uuid NOT NULL REFERENCES customers.customers(id),
  kind text NOT NULL, line1 text NOT NULL, line2 text, city text NOT NULL, region text, postal_code text NOT NULL,
  country char(2) NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS customers.contacts(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid NOT NULL, customer_id uuid NOT NULL REFERENCES customers.customers(id),
  kind text NOT NULL, value text NOT NULL, is_primary boolean NOT NULL DEFAULT false, verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS customers.payment_method_refs(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid NOT NULL, customer_id uuid NOT NULL REFERENCES customers.customers(id),
  provider_token text NOT NULL, type text NOT NULL, brand text, last4 char(4), billing_name text, billing_address jsonb,
  status text NOT NULL DEFAULT 'active', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS customers.customer_imports(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid NOT NULL, source text NOT NULL, object_key text NOT NULL,
  status text NOT NULL, rows_total integer NOT NULL DEFAULT 0, rows_succeeded integer NOT NULL DEFAULT 0,
  rows_failed integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS customers.support_tickets(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid NOT NULL, subject text NOT NULL,
  status text NOT NULL DEFAULT 'open', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS customers.support_participants(
  ticket_id uuid NOT NULL REFERENCES customers.support_tickets(id), customer_id uuid NOT NULL REFERENCES customers.customers(id),
  joined_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(ticket_id,customer_id)
);
CREATE TABLE IF NOT EXISTS customers.support_messages(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid NOT NULL, ticket_id uuid NOT NULL REFERENCES customers.support_tickets(id),
  author_type text NOT NULL, author_id uuid, body text NOT NULL, attachments jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payments.payment_intents(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid NOT NULL, customer_id uuid NOT NULL,
  payment_method_id uuid NOT NULL, amount bigint NOT NULL CHECK(amount>0), currency char(3) NOT NULL,
  status text NOT NULL, description text, provider_payment_id text, customer_snapshot jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS payments.payment_attempts(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid NOT NULL, payment_intent_id uuid NOT NULL REFERENCES payments.payment_intents(id),
  provider_request_id text NOT NULL, status text NOT NULL, failure_code text, failure_message text,
  request_payload jsonb NOT NULL, response_payload jsonb, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(merchant_id,provider_request_id)
);
CREATE TABLE IF NOT EXISTS payments.captures(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid NOT NULL, payment_intent_id uuid NOT NULL REFERENCES payments.payment_intents(id),
  provider_capture_id text UNIQUE NOT NULL, amount bigint NOT NULL, status text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS payments.refunds(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid NOT NULL, payment_intent_id uuid NOT NULL REFERENCES payments.payment_intents(id),
  provider_refund_id text UNIQUE, amount bigint NOT NULL CHECK(amount>0), reason text NOT NULL, status text NOT NULL,
  customer_email text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS payments.disputes(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid NOT NULL, payment_intent_id uuid NOT NULL REFERENCES payments.payment_intents(id),
  provider_dispute_id text UNIQUE NOT NULL, amount bigint NOT NULL, reason text NOT NULL, status text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS payments.invoices(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid NOT NULL, customer_id uuid NOT NULL,
  payment_intent_id uuid REFERENCES payments.payment_intents(id), number text NOT NULL, status text NOT NULL,
  currency char(3) NOT NULL, subtotal bigint NOT NULL, tax bigint NOT NULL, total bigint NOT NULL,
  billing_snapshot jsonb NOT NULL, object_key text, issued_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(merchant_id,number)
);
CREATE TABLE IF NOT EXISTS payments.invoice_lines(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), invoice_id uuid NOT NULL REFERENCES payments.invoices(id),
  description text NOT NULL, quantity integer NOT NULL, unit_amount bigint NOT NULL, total bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS payments.ledger_accounts(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid NOT NULL, code text NOT NULL, name text NOT NULL,
  account_type text NOT NULL, currency char(3) NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(merchant_id,code,currency)
);
CREATE TABLE IF NOT EXISTS payments.ledger_entries(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid NOT NULL, reference_type text NOT NULL,
  reference_id uuid NOT NULL, description text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(merchant_id,reference_type,reference_id)
);
CREATE TABLE IF NOT EXISTS payments.ledger_postings(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), entry_id uuid NOT NULL REFERENCES payments.ledger_entries(id),
  account_id uuid NOT NULL REFERENCES payments.ledger_accounts(id), direction text NOT NULL CHECK(direction IN ('debit','credit')),
  amount bigint NOT NULL CHECK(amount>0), currency char(3) NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS payments.provider_settlements(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid NOT NULL, provider_settlement_id text UNIQUE NOT NULL,
  period_start timestamptz NOT NULL, period_end timestamptz NOT NULL, gross bigint NOT NULL, fees bigint NOT NULL,
  net bigint NOT NULL, currency char(3) NOT NULL, raw_payload jsonb NOT NULL, imported_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS payments.reconciliation_runs(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid NOT NULL, status text NOT NULL,
  ledger_total bigint NOT NULL DEFAULT 0, provider_total bigint NOT NULL DEFAULT 0, discrepancy bigint NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
CREATE TABLE IF NOT EXISTS payments.reconciliation_items(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid NOT NULL REFERENCES payments.reconciliation_runs(id),
  reference_type text NOT NULL, reference_id text NOT NULL, ledger_amount bigint, provider_amount bigint,
  status text NOT NULL, detail jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS operations.outbox_events(
  id uuid PRIMARY KEY, event_type text NOT NULL, event_version integer NOT NULL, aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL, merchant_id uuid NOT NULL, correlation_id uuid NOT NULL, payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS operations.inbox_events(
  consumer text NOT NULL, event_id uuid NOT NULL, event_type text NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz, status text NOT NULL, error text, PRIMARY KEY(consumer,event_id)
);
CREATE TABLE IF NOT EXISTS operations.provider_webhooks(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), provider_event_id text UNIQUE NOT NULL, event_type text NOT NULL,
  signature text NOT NULL, payload jsonb NOT NULL, status text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(), received_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz
);
CREATE TABLE IF NOT EXISTS operations.jobs(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), queue text NOT NULL, job_type text NOT NULL, merchant_id uuid,
  payload jsonb NOT NULL, status text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 8, available_at timestamptz NOT NULL DEFAULT now(), locked_by text,
  locked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS operations.job_attempts(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid NOT NULL REFERENCES operations.jobs(id),
  worker_id text NOT NULL, status text NOT NULL, error text, started_at timestamptz NOT NULL, finished_at timestamptz
);
CREATE TABLE IF NOT EXISTS operations.dead_letters(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source text NOT NULL, source_id text NOT NULL, event_type text NOT NULL,
  payload jsonb NOT NULL, error text NOT NULL, failed_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz
);
CREATE TABLE IF NOT EXISTS operations.idempotency_keys(
  merchant_id uuid NOT NULL, scope text NOT NULL, key text NOT NULL, request_hash text NOT NULL,
  response_status integer, response_body jsonb, locked_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  PRIMARY KEY(merchant_id,scope,key)
);
CREATE TABLE IF NOT EXISTS operations.analytics_events(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid NOT NULL, customer_id uuid, anonymous_id text,
  event_type text NOT NULL, email text, properties jsonb NOT NULL, occurred_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS operations.notification_preferences(
  merchant_id uuid NOT NULL, customer_id uuid NOT NULL, channel text NOT NULL, destination text NOT NULL,
  enabled boolean NOT NULL DEFAULT true, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(merchant_id,customer_id,channel)
);
CREATE TABLE IF NOT EXISTS operations.notifications(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid NOT NULL, customer_id uuid, channel text NOT NULL,
  destination text NOT NULL, template text NOT NULL, payload jsonb NOT NULL, status text NOT NULL,
  attempts integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(), delivered_at timestamptz
);
CREATE TABLE IF NOT EXISTS operations.document_manifests(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid NOT NULL, customer_id uuid, object_key text UNIQUE NOT NULL,
  document_type text NOT NULL, content_type text NOT NULL, checksum text NOT NULL, metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS operations.projection_checkpoints(
  projection text NOT NULL, partition integer NOT NULL, offset_value bigint NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(projection,partition)
);

CREATE INDEX IF NOT EXISTS customers_by_merchant ON customers.customers(merchant_id,status,created_at);
CREATE INDEX IF NOT EXISTS payments_by_customer ON payments.payment_intents(merchant_id,customer_id,created_at);
CREATE INDEX IF NOT EXISTS outbox_pending ON operations.outbox_events(status,available_at,created_at);
CREATE INDEX IF NOT EXISTS jobs_pending ON operations.jobs(queue,status,available_at);
CREATE INDEX IF NOT EXISTS webhooks_pending ON operations.provider_webhooks(status,next_attempt_at);

CREATE OR REPLACE FUNCTION payments.reject_ledger_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'ledger postings are append-only'; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS ledger_postings_immutable ON payments.ledger_postings;
CREATE TRIGGER ledger_postings_immutable BEFORE UPDATE OR DELETE ON payments.ledger_postings
FOR EACH ROW EXECUTE FUNCTION payments.reject_ledger_mutation();
