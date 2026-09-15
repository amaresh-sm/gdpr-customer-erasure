# Repository notes for agents

PayFlow is a small multi-service TypeScript monorepo (Fastify HTTP services +
background workers) sharing one Postgres database across bounded contexts
(`customers`, `payments`, `operations`, `platform`, `provider_sandbox`
schemas). Services talk to Postgres directly (no ORM), publish domain events
through a transactional outbox (`operations.outbox_events`) onto Kafka
(Redpanda), and use Redis/OpenSearch/MinIO/Mailpit as read/side-effect stores.

## Environment
- No git repo is present in `/workspace/source` (this is a snapshot, not a
  git checkout) — don't expect `git log`/`git status` to work.
- Node 22, npm workspoces-free single `package.json`. `npm ci` then
  `npm run typecheck` / `npm run lint` / `npm test` are fast (no docker
  needed) and should be run after any change.
- Full integration testing requires `docker compose up -d`. The `mailpit`
  container's healthcheck must run `wget -Y off ...` (not plain `wget`)
  because this sandbox injects an `HTTP_PROXY`/`HTTPS_PROXY` env var into
  every container, which busybox `wget` honors even for `localhost` unless
  proxying is explicitly disabled with `-Y off`.
- `docker compose --profile tools run --rm seed|runtime-check` and
  `npm run scenario` / `npm run smoke` are the existing end-to-end checks;
  `scripts/check-runtime.ts` asserts the whole system (outbox, jobs, emails,
  ledger, receipts, Redis/OpenSearch/MinIO/Mailpit parity) converged.

## Background workers
Every worker in `apps/*-worker` follows the same shape: a `claim*`/`complete*`/
`fail*` lifecycle module (see `packages/operations/src/job-lifecycle.ts`,
`packages/notifications/src/delivery-lifecycle.ts`) backed by a Postgres row
with `status`, `attempts`, `available_at`/`lease_expires_at`, polled in a
`while (!signal.aborted)` loop with `SKIP LOCKED`, plus a periodic
"recover expired leases" sweep. Failures always store a short, stable string
in `last_error` (never a raw error message that could leak customer data).

## Customer data erasure (privacy)
Implements `docs/privacy-api.md` / `docs/privacy-and-retention.md`.
- `customers.erasure_requests` (one row per customer per merchant, unique on
  `(merchant_id, customer_id)`) is both the API-visible request record *and*
  the durable work queue for `apps/privacy-worker`.
- `customers.erasure_idempotency_keys` scopes `Idempotency-Key` reuse to the
  merchant and maps it to the customer it was first used for
  (`apps/customer-service/src/erasure-service.ts` implements the exact
  replay/conflict/reuse rules from `docs/privacy-api.md`).
- All erasure side effects live in `packages/privacy/src/erasure-workflow.ts`
  (`eraseCustomerData`) and are idempotent: re-running it (after a retry or a
  worker restart) always converges on the same fully-redacted state. Steps:
  purge captured Mailpit messages, rewrite stored receipt/invoice JSON in
  MinIO in place (redacting the embedded `customer` object, keeping
  amounts/lines), anonymize `customers.customers` (+ addresses/contacts/
  payment methods/support content), anonymize `customer_snapshot` /
  `billing_snapshot` on existing `payments.payment_intents` /
  `payments.invoices` (financial fields untouched), redact `refunds.
  customer_email`, then clear the Redis/OpenSearch customer projections
  (which get lazily repopulated in redacted form by the normal
  `customer.updated` event the workflow emits, exercised by
  `apps/projection-worker`).
- Failures are mapped to a small closed set of PII-free codes in
  `packages/privacy/src/errors.ts` (`ErasureStepError`/`toErasureErrorCode`)
  so `lastError` returned by `GET /v1/erasure-requests/:id` never contains
  customer data.
- An erased customer's `status` becomes `'erased'`, which the existing
  `payment-service` "customer is not active" check already blocks new
  payments against — no extra guard was needed there.
