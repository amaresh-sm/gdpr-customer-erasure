# PayFlow repository notes

## Layout
- `apps/*` are deployables (fastify services and polling workers); `packages/*` are shared libraries.
- Imports are relative paths with `.js` extensions (NodeNext). There is no workspace/package indirection.
- Migrations in `packages/database/migrations` are checksum-locked: never edit an applied file, add a new one.

## Public checks
- `npm run typecheck`, `npm run lint`, `npm test` run without infrastructure.
- Infrastructure checks need `docker compose up --build -d`, then
  `docker compose --profile tools run --rm seed`, `npm run scenario`, `npm run smoke`,
  `npm run check:runtime`, `npm run provider:check`.
- In this container the `mailpit` healthcheck never turns healthy (its image lacks `wget`), so
  compose reports a dependency failure. Mailpit itself works; start dependents with
  `docker compose up -d --no-deps <service>` and run `check:runtime` from the host with
  localhost-pointing env vars instead of the `runtime-check` compose service.
- `npm run scenario` and host-run scripts need localhost env vars; the Kafka broker only advertises
  `redpanda:9092`, so host processes cannot produce to Kafka (publish via `operations.outbox_events`).

## Customer data deletion
- API: `POST /v1/customers/:customerId/erasure-requests`, `GET /v1/erasure-requests/:requestId`
  (scope `privacy:erase`), implemented in `apps/customer-service/src/erasure-*.ts`.
- `privacy.erased_customers` is the retained deletion record and the suppression list every worker
  consults, so replayed events, provider callbacks, and retried jobs cannot restore personal data.
- `privacy.redact_pii` (SQL) and `packages/privacy/src/redaction.ts` (TS) must list the same keys.
- Cleanup order is external systems first, database last, because the database is the source the
  other systems are rebuilt from; the final step commits completion in the same transaction.
