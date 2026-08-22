# Architecture

## Deployables

```text
api-gateway
  |-- customer-service ------ PostgreSQL(customers) + Redis
  |-- payment-service ------- PostgreSQL(payments) + MinIO
  |      `-- mock-processor -- delayed signed webhooks
  |-- reconciliation-service -- immutable ledger + provider settlements
  |-- privacy-service ------- durable erasure workflow + participant registry
  |
  `-- Kafka/Redpanda
         |-- projection-worker ---- Redis + OpenSearch
         |-- notification-worker -- PostgreSQL delivery queue -> Mailpit provider
         |-- webhook-worker ------- inbox -> payment state machine
         `-- document-worker ------ durable jobs -> MinIO receipts
```

Each service owns its schema and repository layer. Cross-service reads occur through HTTP or
versioned events. Business transactions write domain state and an outbox record atomically.
Consumers use durable inbox/checkpoint records and tolerate duplicate delivery.

Receipt creation deliberately crosses an asynchronous boundary. The webhook worker commits the
capture, ledger entry, payment event, and document job together. The document worker claims jobs
with `SKIP LOCKED`, writes a deterministic MinIO object, records its checksum manifest, and emits a
receipt event. Attempts are retained and terminal failures move to the dead-letter table.

## Outbound email

The notification worker translates payment and invoice events into durable
`operations.email_deliveries` records. It renders the recipient address and product payload before
submitting the message through the local Mailpit provider API. Delivery records are claimed with
`SKIP LOCKED`, retry transient provider failures with backoff, and retain a provider message
reference when delivery succeeds. Mailpit is an application-owned captured-mail provider in this
environment: its SMTP/API mailbox is operational state, not an end user's external inbox.

## Non-negotiable boundaries

- Every merchant-facing query includes `merchant_id`.
- Services never query another service's schema from production code.
- Ledger postings are append-only and balanced per transaction.
- Provider webhook IDs, API idempotency keys, and Kafka event IDs are independently deduplicated.
- Search, caches, analytics, and notifications are projections, not sources of financial truth.
- Replay must rebuild projections without changing financial state.
