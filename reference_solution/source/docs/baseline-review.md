# Baseline readiness review

## Scope

This review covers the ordinary PayFlow product baseline. The baseline intentionally excludes any
data-erasure endpoint, erasure registry, benchmark verifier, candidate instructions, or reference
solution. Those are separate future layers and must not be mixed into the product starting point.

## Complexity evidence

- Nine long-running application processes: gateway, customer API, payment API, processor simulator,
  webhook state-machine worker, document job worker, projection worker, notification worker, and
  reconciliation API.
- Five real stateful infrastructure systems: PostgreSQL, Redis, Redpanda, MinIO, and OpenSearch.
- Multi-tenant scoped authentication and two independently seeded merchants.
- Synchronous HTTP boundaries plus asynchronous signed webhooks, transactional outbox delivery,
  Kafka inbox deduplication, projection checkpoints, durable jobs, retries, and dead letters.
- Immutable double-entry journals, captures, partial refunds, settlement imports, and reconciliation.
- Customer, support, invoice, receipt, notification, analytics, cache, and search business flows.

## Verified gates

- Strict TypeScript compile, ESLint, Node test suite, and production build pass.
- `npm audit --omit=dev` reports zero known vulnerabilities.
- Docker Compose configuration validates and every runtime service starts.
- Business scenarios complete through public APIs for both seeded merchants.
- Cross-tenant access is denied while same-tenant access succeeds.
- Replaying the same payment request with one idempotency key returns the original resource.
- Settlement reconciliation reaches zero discrepancy.
- Runtime verification finds no dead letters, unfinished jobs/webhooks, unbalanced journals,
  missing captures, missing receipts, or cross-store projection discrepancies.

## Freeze rule

The tagged baseline is the source for later task construction. Any future benchmark-specific work
must branch from it and preserve a clean product baseline for comparison.
