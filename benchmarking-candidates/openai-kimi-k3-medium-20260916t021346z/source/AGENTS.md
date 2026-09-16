# PayFlow repository notes

## Customer data deletion (erasure)

Implemented per `docs/privacy-api.md` and `docs/privacy-and-retention.md`.

- **API** (customer-service, see `apps/customer-service/src/erasure.ts`):
  `POST /v1/customers/:id/erasure-requests` (scope `privacy:erase`, `Idempotency-Key` 8-200 chars)
  and `GET /v1/erasure-requests/:requestId`. Gateway proxies both prefixes.
  Idempotency keys live in `customers.erasure_request_keys` (every presented key is recorded);
  one request per customer (`UNIQUE(merchant_id,customer_id)`); reposting a failed request
  requeues it (attempts reset, same request id); request lookup precedes the customer-existence
  check so reposts keep working after the customer row is replaced.
- **Schema** (`009_customer_erasure.sql`): `customers.erasure_requests` carries a
  `replacement_id` (fresh uuid). Retained financial records (payment_intents, invoices,
  document_manifests, provider_sandbox.customers, outbox/jobs payloads) are re-pointed to the
  replacement id and scrubbed of PII; the original customer row is deleted and an anonymous
  tombstone row (`status='erased'`) is inserted with the replacement id. Do not rename the
  migration to `002_*`: shared dev volumes already recorded unrelated `002_*` erasure
  migrations and the migrator rejects modified files.
- **Worker** (`apps/privacy-worker`): claims pending/failed requests (`next_attempt_at`,
  `locked_at` lease, backoff, 8 attempts), runs an idempotent scrub: one DB transaction
  (locks customer + payments + refunds to serialize with webhooks, deletes non-financial rows,
  pseudonymizes financial rows, emits `customer.erased.v1`), then MinIO sweep (deletes matching
  imports, rewrites receipts/invoices with `customer: {erased: true}` + manifest checksum),
  then Redis/OpenSearch PII-free tombstone projections (keeps runtime-check counts stable).
  Failure codes are stable strings (`database_cleanup_failed`, `object_store_cleanup_failed`,
  `cache_cleanup_failed`, `search_cleanup_failed`).
- **Race-proofing**: writers lock the customer row and require `status='active'`
  (payment prepare, invoice create, address/contact/payment-method/support writes,
  provider-customer mapping, customer PATCH). Consumers (projection, notification,
  document workers) skip or scrub PII when `isCustomerErasureRequested` (erasure request
  exists or customer not active); DB-writing consumers check under a per-customer advisory
  lock (`erasureLockKey`) shared with the scrub transaction. Provider sandbox customer upsert
  is guarded by `NOT EXISTS(erasure_requests)`.

## Gotchas

- `packages/database/src/pool.ts` and `packages/storage/src/minio.ts` call `config()` at module
  load — unit tests must only import config-free modules (e.g. `packages/privacy/src/erasure.ts`,
  `packages/contracts/src/*`).
- Postgres infers pg parameter types per query: a parameter used as both uuid and text needs
  `$n::uuid::text`, and every parameter in the params array must appear in the query.
- `scripts/check-runtime.ts` asserts projections (Redis/OpenSearch) >= customer rows and
  MinIO objects == manifests; the erasure flow preserves these by keeping tombstone
  customers/projections and rewriting (not deleting) financial documents.
- Host `node_modules` (macOS) cannot be bind-mounted into Linux containers (esbuild); rebuild
  images or `docker cp` files into running containers for debugging.
