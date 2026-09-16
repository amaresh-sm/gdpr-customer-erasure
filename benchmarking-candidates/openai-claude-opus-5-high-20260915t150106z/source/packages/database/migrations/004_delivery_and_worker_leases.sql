ALTER TABLE operations.jobs
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_error text;

ALTER TABLE operations.provider_webhooks
  ADD COLUMN IF NOT EXISTS locked_by text,
  ADD COLUMN IF NOT EXISTS locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_error text;

ALTER TABLE operations.email_deliveries
  ADD COLUMN IF NOT EXISTS locked_by text,
  ADD COLUMN IF NOT EXISTS locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS provider_response jsonb;

ALTER TABLE operations.notifications
  ADD COLUMN IF NOT EXISTS delivery_id uuid REFERENCES operations.email_deliveries(id),
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS jobs_lease_recovery
  ON operations.jobs(status, lease_expires_at)
  WHERE status = 'processing';

CREATE INDEX IF NOT EXISTS provider_webhooks_lease_recovery
  ON operations.provider_webhooks(status, lease_expires_at)
  WHERE status = 'processing';

CREATE INDEX IF NOT EXISTS email_deliveries_lease_recovery
  ON operations.email_deliveries(status, lease_expires_at)
  WHERE status = 'processing';

CREATE INDEX IF NOT EXISTS notifications_by_delivery
  ON operations.notifications(delivery_id);
