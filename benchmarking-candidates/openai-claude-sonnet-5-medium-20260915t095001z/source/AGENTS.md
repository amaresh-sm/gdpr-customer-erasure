# Repository notes for agents

PayFlow is a small "microservices in one repo" TypeScript/Node payment platform. Services under
`apps/*` talk to a single Postgres instance with per-domain schemas (`platform`, `customers`,
`payments`, `operations`, `provider_sandbox`). Shared code lives in `packages/*`.

## Environment
- `npm install` then `docker compose up -d postgres redis redpanda minio opensearch mailpit` to get
  local infra. `npm run migrate` applies `packages/database/migrations/*.sql` in filename order
  (checksummed, so don't edit an already-applied migration — add a new one).
- `npm run seed` creates two demo merchants/API keys (see `scripts/seed.ts`).
- `npm test` / `npm run typecheck` / `npm run lint` are the fast local checks; all passed as of this
  change.
- When running services outside Docker, `KAFKA_BROKERS`/`MINIO_ENDPOINT` etc. must resolve — either
  run inside `docker compose` (recommended, hostnames like `postgres`/`redpanda` resolve on the
  compose network) or override `.env` with `localhost` and expose ports.

## Customer data deletion (privacy erasure)
Implemented per `docs/privacy-api.md` and `docs/privacy-and-retention.md`:
- `POST /v1/customers/:customerId/erasure-requests` and `GET /v1/erasure-requests/:requestId` live in
  `apps/customer-service` (`routes.ts`, `erasure-service.ts`, `erasure-repository.ts`,
  `erasure-executor.ts`, `erasure-worker.ts`). Requires API key scope `privacy:erase`.
- Migration `009_customer_erasure.sql` adds `customers.erasure_requests` (one row per customer,
  `UNIQUE(merchant_id,customer_id)`), linked to an `operations.jobs` row (`queue='privacy-erasure'`).
- Request creation reuses `packages/operations/src/idempotency.ts` (shared with
  `apps/payment-service/src/idempotency.ts`, which now just re-exports it) with
  `scope='erasure-request'` and `hash=sha256(customerId)`. This gives, for free: same key + same
  customer replays the stored response; same key + different customer -> 409; different key + same
  customer with an existing request -> returns the existing request without starting new work.
- The actual anonymization runs asynchronously via the existing durable job lifecycle
  (`packages/operations/src/job-lifecycle.ts`, `claimJob`/`completeJob`/`failJob`), so it is
  crash-safe and retried automatically (`max_attempts=20` for this queue). `eraseCustomerData` in
  `erasure-executor.ts` is written so every statement is idempotent (deterministic anonymized
  values, `DELETE`s, jsonb key removal) — safe to re-run after a partial failure.
- What gets erased vs. retained: `customers.customers` is anonymized in place (status becomes
  `'erased'`, email/name/external_reference replaced with deterministic placeholders, no more PII);
  addresses/contacts/payment method refs are deleted; support messages authored by the customer are
  redacted (ticket subject too, but only when no other customer participates in that ticket, so
  shared tickets aren't touched). Financial rows (`payments.payment_intents`,
  `payments.refunds`, `payments.invoices`) are kept for accounting but their PII-bearing
  columns (`customer_snapshot`, `customer_email`, `billing_snapshot`) are overwritten with redacted
  placeholders; invoice/receipt objects in MinIO are rewritten with a redacted JSON body.
  `operations.analytics_events`/`notifications`/`email_deliveries`/`notification_preferences` are
  scrubbed or deleted since they're operational, not financial. A `customer.erased.v1` outbox event
  lets `projection-worker` remove the OpenSearch document and Redis cache entries for that customer
  (systems it owns that the customer-service can't reach via SQL).
- Once a customer is `'erased'`, `apps/customer-service/src/repository.ts` blocks new
  addresses/contacts/payment-methods/support-tickets/profile updates for that customer (queries add
  `AND status<>'erased'`), so retried/duplicate payment flows can't resurrect PII. Payment creation
  already rejected non-`'active'` customers, so it's blocked too.
- `apps/api-gateway/src/routes.ts` proxies `/v1/erasure-requests` to the customer service (the
  `/v1/customers` prefix already covers the POST route).
- `scripts/seed.ts` API keys now include the `privacy:erase` scope.

If extending this: any new table/column that stores customer PII (email, name, phone, free-text
support content, billing info) needs a corresponding idempotent redaction step in
`erasure-executor.ts`, and anything projected into Redis/OpenSearch/Kafka needs to react to
`EVENT_TYPES.CUSTOMER_ERASED` the way `projection-worker` does.
