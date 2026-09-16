# Repository notes for agents

## Local dev/test environment
- `npm install` at repo root installs everything (single workspace, no per-package installs needed).
- Full stack: `docker compose up -d` (builds images from the single root `Dockerfile`). The `migrator`
  and `seed` (profile `tools`) containers apply `packages/database/migrations/*.sql` and seed two
  demo merchants (`scripts/seed.ts`).
- Running services directly on the host (`npm run start:*`) requires a `.env`-style file pointing
  `POSTGRES_URL`/`REDIS_URL`/`KAFKA_BROKERS`/etc at `localhost` instead of the compose service names.
  This mostly works, but Kafka is flaky from the host because Redpanda advertises
  `redpanda:9092` (a Docker-internal name) — outbox publishing hangs/retries forever. For anything
  that depends on outbox events actually publishing (e.g. `npm run check:runtime`), run it **inside**
  the compose network instead, e.g. `docker compose run --rm api-gateway npm run scenario` and
  `docker compose run --rm runtime-check`.
- In this sandbox, mailpit's own healthcheck can fail with `403 Forbidden` because an egress proxy
  intercepts even `localhost` calls inside its container. Work around it with
  `docker compose run --rm --no-deps -e NO_PROXY='*' -e no_proxy='*' <service>` when a dependency
  gate blocks on mailpit being "healthy" — mailpit itself is fine, just the healthcheck command.

## Customer data deletion (erasure)
Implemented per `docs/privacy-api.md` and `docs/privacy-and-retention.md`:
- `POST /v1/customers/:customerId/erasure-requests` and `GET /v1/erasure-requests/:requestId` live in
  `apps/customer-service/src/erasure/` (routes/service/repository/worker/external-systems/dto).
- One workflow per customer ever (`UNIQUE(merchant_id,customer_id)` on `customers.erasure_requests`),
  idempotency-key handling reuses `packages/operations/src/idempotency.ts` (moved out of
  `apps/payment-service` so both services can share it — that file now just re-exports it).
- The erasure worker (`apps/customer-service/src/erasure/worker.ts`, started from
  `customer-service/src/main.ts` alongside the outbox publisher) redacts PII across every
  Postgres schema in one transaction (`ErasureRepository.runDatabaseStep`), then rewrites/deletes
  the corresponding MinIO objects, removes the OpenSearch doc and Redis cache entries, and purges
  Mailpit-captured mail — all idempotent so retries never resurrect PII.
- Financial rows (payment_intents, invoices, refunds) are never deleted — only their embedded
  customer identity fields are replaced with a deterministic placeholder
  (`packages/privacy/src/snapshot.ts` / `redaction.ts`), keeping amounts/currency/status intact.
- `customers.customer_imports` previously had no `customer_id` column, making imported PII
  impossible to trace back to a customer for erasure — added the column (migration
  `009_customer_erasure.sql`) and threaded `customerId` through the import API/service/repository.
- `scripts/check-runtime.ts` now expects Redis/OpenSearch customer projections to match
  non-erased customers only (erased customers are intentionally absent from both).
