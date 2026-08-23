ALTER TABLE operations.outbox_events
  ADD COLUMN IF NOT EXISTS locked_by text,
  ADD COLUMN IF NOT EXISTS locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_error text;

CREATE INDEX IF NOT EXISTS outbox_lease_recovery
  ON operations.outbox_events(status,lease_expires_at)
  WHERE status='publishing';

ALTER TABLE provider_sandbox.payment_intents
  ADD COLUMN IF NOT EXISTS available_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS webhook_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_delivery_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS webhook_delivered_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_delivery_error text;

ALTER TABLE provider_sandbox.refunds
  ADD COLUMN IF NOT EXISTS webhook_url text,
  ADD COLUMN IF NOT EXISTS available_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS webhook_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_delivery_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS webhook_delivered_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_delivery_error text;

CREATE INDEX IF NOT EXISTS sandbox_payment_callbacks
  ON provider_sandbox.payment_intents(webhook_delivered_at,next_delivery_at)
  WHERE webhook_delivered_at IS NULL;

CREATE INDEX IF NOT EXISTS sandbox_refund_callbacks
  ON provider_sandbox.refunds(webhook_delivered_at,next_delivery_at)
  WHERE webhook_delivered_at IS NULL;

ALTER TABLE operations.analytics_events
  ADD COLUMN IF NOT EXISTS source_event_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS analytics_event_source
  ON operations.analytics_events(source_event_id)
  WHERE source_event_id IS NOT NULL;
