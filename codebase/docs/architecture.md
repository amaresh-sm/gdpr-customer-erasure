# Architecture

## Deployables

```text
api-gateway
  |-- customer-service ------ PostgreSQL(customers) + Redis
  |-- payment-service ------- PostgreSQL(payments) + provider sandbox + reconciliation
  |      `-- delayed signed webhooks and immutable provider settlements
  |
  `-- Kafka/Redpanda
         |-- projection-worker ---- Redis + OpenSearch
         |-- notification-worker -- PostgreSQL delivery queue -> Mailpit provider
         |-- webhook-worker ------- inbox -> payment state machine
         `-- document-worker ------ durable jobs -> MinIO receipts
```

The `customers` and `payments` bounded contexts own their PostgreSQL schemas. A bounded context can
have more than one deployable: for example, the payment API and webhook worker both participate in
the payments state machine. Shared delivery infrastructure lives in the `operations` schema.
Cross-context reads occur through HTTP or versioned events, not by reaching into another context's
tables. SQL is kept in repositories and transaction-focused domain modules so locking and ledger
behavior remain explicit without mixing persistence into HTTP or process entrypoints.

The payments deployable includes a local provider sandbox for development and its reconciliation
module. The sandbox uses an isolated `provider_sandbox` schema, persists accepted operations, and
retries signed webhook delivery after restarts. Production deployments would replace the sandbox
module with a remote provider adapter while preserving the client contract.

Receipt creation deliberately crosses an asynchronous boundary. The webhook worker commits the
capture, ledger entry, payment event, and document job together. The document worker claims jobs
with `SKIP LOCKED` and a time-limited lease, writes a deterministic MinIO object, records its
checksum manifest, and emits a receipt event. Attempts are retained, expired leases are recovered,
and terminal failures move to the dead-letter table.

## Outbound email

The notification worker translates payment and invoice events into durable
`operations.email_deliveries` records. It renders the recipient address and product payload before
submitting the message through the local Mailpit provider API. Delivery records are claimed with
`SKIP LOCKED` and a time-limited lease, retry transient provider failures with backoff, and retain
delivery attempts and a provider message reference. Mailpit is an application-owned captured-mail provider in this
environment: its SMTP/API mailbox is operational state, not an end user's external inbox.

## Non-negotiable boundaries

- Every merchant-facing query includes `merchant_id`.
- Bounded contexts do not query one another's schemas; their cooperating API and worker
  deployables may share the schema owned by that context.
- Ledger postings are append-only and balanced per transaction.
- Provider webhook IDs, API idempotency keys, and Kafka event IDs are independently deduplicated.
- Search, caches, analytics, and notifications are projections, not sources of financial truth.
- Replay must rebuild projections without changing financial state.
