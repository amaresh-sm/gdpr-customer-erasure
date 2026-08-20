# Private Phase 5 build handoff

## Reference implementation

- Branch: `solution/gdpr-customer-erasure`
- Baseline: `payflow-platform-v1.0.0`
- Public API: create/resume and inspect erasure requests through the API gateway.
- Durable state: request, participant checkpoints, lease/retry metadata, and minimal tombstone.
- Registered participants: quiescence, finance, objects, operations, projections, customer records,
  and completion verification.
- Async defenses: projection and notification suppression, redacted document jobs, and sanitized
  payment snapshots used by delayed webhooks.

## Automated verification

- TypeScript typecheck: pass.
- ESLint: pass with zero warnings.
- Unit tests: 4/4 pass.
- Production build: pass.
- Existing semantic runtime verifier: pass after making its Redis assertion honor the documented
  one-hour cache TTL.

## Live Docker verification

- Normal erasure: completed in one attempt; all seven checkpoints completed.
- PostgreSQL target rows: absent across direct customer, address, contact, payment-method, and
  notification stores.
- Financial invariants: payment amount/currency/status retained; ledger posting count and signed
  balance unchanged; customer snapshot reduced to an erased-subject reference.
- Redis: no raw customer key.
- OpenSearch: raw customer document returned 404.
- MinIO: zero raw UUID/email hits; retained documents redacted.
- Idempotency: same and different keys for the erased customer returned the same request; key reuse
  for another customer returned 409.
- Tenant isolation: wrong-merchant request returned 404.
- Delayed webhook: delivered after completion, created its capture, balanced ledger, job, manifest,
  and receipt without the raw UUID or PII.
- Historical event: both consumers recorded it processed, with zero analytics, notification,
  Redis, or OpenSearch resurrection.
- MinIO outage: request remained failed at `object-storage`; after recovery it resumed completed
  checkpoints and completed on attempt four.

The independent hidden fixture/verifier and repeated determinism runs belong to later benchmark
phases and are intentionally not represented as complete here.
