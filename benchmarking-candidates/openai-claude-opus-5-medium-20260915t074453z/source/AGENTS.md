# PayFlow repository notes

## Layout

- `apps/*` — deployables (`api-gateway`, `customer-service`, `payment-service`, `webhook-worker`,
  `projection-worker`, `notification-worker`, `document-worker`).
- `packages/*` — shared libraries (config, database, auth, contracts, messaging, storage, search,
  notifications, operations, payments, privacy, http, documents, observability).
- `packages/database/migrations` — numbered SQL migrations, applied by checksum. Never edit an
  applied migration; add a new file.
- Imports are relative with `.js` extensions (NodeNext ESM + `tsx`).

## Conventions

- Every durable workflow uses the same shape: a claim query with `locked_by`/`lease_expires_at`,
  bounded exponential backoff (`packages/operations/src/retry-policy.ts`), lease recovery on a
  timer, and dead letters after exhausting attempts.
- Public routes authenticate with `authenticate(request, scope)`; merchant scoping is applied in
  every SQL predicate (`merchant_id=$1`).
- Errors are thrown as `Object.assign(new Error(msg), { statusCode })`.

## Customer data deletion (privacy)

- API: `POST /v1/customers/:customerId/erasure-requests`, `GET /v1/erasure-requests/:requestId`,
  scope `privacy:erase`, owned by `customer-service`, proxied by the gateway.
- `privacy.erasure_requests` tracks the workflow; `privacy.erased_customers` is the tombstone that
  stops delayed work from restoring PII. The tombstone is written in the same transaction that
  creates the request, so protection starts before any cleanup runs.
- Cleanup is a list of named idempotent steps (`packages/privacy/src/erasure-policy.ts`) recorded in
  `erasure_requests.completed_steps`, so retries and restarts preserve finished work.
- Financial records (payments, refunds, invoices, ledger, settlements, reconciliation) are retained
  and de-identified in place. Ledger postings are append-only and contain no PII, so they are never
  touched.
- Resurrection guards live in `packages/privacy/src/tombstone.ts` and are consulted by the webhook
  processor, document worker, notification worker/sender and projection worker. Kafka consumers
  subscribe `fromBeginning: true`, so replayed events must always be checked against the tombstone.
- `npm run privacy:check` exercises the whole flow against the local Compose environment.
