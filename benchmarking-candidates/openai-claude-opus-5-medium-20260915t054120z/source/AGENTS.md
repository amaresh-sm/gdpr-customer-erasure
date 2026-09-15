# PayFlow repository notes

## Layout

- `apps/*` are deployables (Fastify services and Kafka/queue workers); `packages/*` are shared
  libraries. Everything is one TypeScript project (`tsconfig.json` covers `apps`, `packages`,
  `scripts`, `tests`) and imports use relative `.js` specifiers.
- All services share one Postgres instance with schemas `platform`, `customers`, `payments`,
  `operations`, `provider_sandbox` and `privacy`.
- The API gateway only proxies whitelisted prefixes, so a new public prefix must be added to
  `apps/api-gateway/src/routes.ts`.
- The payment provider is simulated inside `payment-service`
  (`provider-sandbox-routes.ts`), which calls back into `webhook-worker`.

## Conventions

- Migrations are append-only and checksummed: never edit an applied file in
  `packages/database/migrations`, add a new numbered one.
- Async work uses the same durability pattern everywhere: claim with a lease, bounded exponential
  backoff (`packages/operations/src/retry-policy.ts`), lease recovery for crashed workers, and
  dead letters after exhausting attempts.
- Cross-service reads go over HTTP; `operations.inbox_events` gives consumers idempotency.
- Verification scripts are plain `tsx` scripts under `scripts/` that assert with
  `node:assert/strict` and print a JSON summary.

## Checks

`npm run typecheck`, `npm run lint`, `npm test` need no running services. `npm run smoke`,
`npm run scenario`, `npm run privacy:check`, `npm run provider:check` and
`docker compose --profile tools run --rm runtime-check` need the compose environment plus
`npm run seed`.

Host-run scripts need the service URLs pointed at `localhost` rather than the compose
hostnames in `.env.docker`.

In this sandbox the `mailpit` container reports `unhealthy` because its `wget` healthcheck is
intercepted by an egress proxy; the Mailpit API itself works. Services that `depends_on`
mailpit's health will not start, so start them with `docker compose up -d --no-deps <service>`.

## Customer data deletion

- API: `POST /v1/customers/:customerId/erasure-requests` and `GET /v1/erasure-requests/:requestId`,
  served by `customer-service`, scope `privacy:erase`, documented in `docs/privacy-api.md` and
  `docs/privacy-and-retention.md`.
- `packages/privacy/src/erasure.ts` runs an ordered list of idempotent steps
  (`ERASURE_STEPS`), each recorded in `privacy.erasure_steps` in the same transaction as its
  work, so a retry resumes instead of repeating destructive work. The worker
  (`packages/privacy/src/worker.ts`) runs in-process in `customer-service`.
- `privacy.erased_customers` is the tombstone: it holds no personal data and is written before
  anything is deleted. It is what stops replayed events, retried jobs, late provider callbacks
  and ordinary API writes from recreating a subject — the guards live in
  `packages/privacy/src/guards.ts` and are applied in the customer repository, the projection,
  notification and document workers, and the email delivery claim.
- Kafka retains already-published messages, so PII cannot be removed from the log itself.
  Replay safety comes from `operations.inbox_events` deduplication plus the tombstone guards in
  every consumer; scrubbing outbox payloads keeps the same data out of future deliveries.
- Retention: payments, captures, refunds, invoices, ledger entries and their receipt/invoice
  documents are kept, with identifying attributes replaced via `redactedCustomerSnapshot` and
  `redactDocument`. Amounts, currencies, quantities, statuses and timestamps are never touched.
  Merchant-written free text (payment and invoice line descriptions) is treated as personal data
  because it routinely names the subject.
