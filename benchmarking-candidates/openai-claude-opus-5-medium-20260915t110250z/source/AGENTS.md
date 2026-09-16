# PayFlow repository notes

## Layout
- `apps/*` — deployables (Fastify services and Kafka/job workers), `packages/*` — shared libraries.
- Everything shares one PostgreSQL database with schemas `platform`, `customers`, `payments`,
  `operations`, `provider_sandbox`, and `privacy`.
- Migrations are ordered SQL files in `packages/database/migrations` and are checksum-locked once
  applied: never edit an applied migration, add a new one.
- Local stack: `docker compose up --build -d`, then `docker compose --profile tools run --rm seed`.
  Checks: `npm run lint`, `npm run typecheck`, `npm test`, `npm run smoke`, `npm run scenario`,
  `npm run provider:check`, and the `runtime-check` / `privacy-check` compose tool profiles.
- Sandbox gotchas: the `mailpit` healthcheck fails here because an HTTP proxy is injected into
  containers and answers wget with 403, which blocks any compose service that waits on it — run
  those with `docker compose run --rm --no-deps <service>`. OpenSearch also refuses writes once the
  host disk passes its flood-stage watermark; raise the watermark via `_cluster/settings` and clear
  `index.blocks.read_only_allow_delete` to recover. Neither is a repository defect.

## Customer data deletion (privacy)
- Public API lives in `apps/customer-service/src/erasure-routes.ts`
  (`POST /v1/customers/:customerId/erasure-requests`, `GET /v1/erasure-requests/:requestId`),
  proxied by the gateway; both require the `privacy:erase` API key scope.
- `privacy.erasure_requests` tracks one request per (merchant, customer) with lease-based retry;
  `privacy.erased_customers` is the retained tombstone that stops delayed work from restoring PII.
- The worker (`erasure-worker.ts`) runs ordered, individually recorded steps so it can resume after a
  crash: `tombstone`, `search`, `cache`, `objects`, `messaging`, `records`.
- Financial records are kept but de-identified: `payments.payment_intents.customer_snapshot`,
  `payments.invoices.billing_snapshot`, `payments.refunds.customer_email`, and stored
  receipt/invoice objects are redacted rather than deleted.
- Consumers (`projection-worker`, `notification-worker`, `document-worker`) call
  `isCustomerErased` before writing customer data, because Kafka replays and provider callbacks can
  arrive after deletion.
