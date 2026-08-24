# Operations runbook

## Startup and readiness

`docker compose up --build -d` starts infrastructure, applies checksum-protected migrations, and
then starts application services. PostgreSQL, Redis, Redpanda, MinIO, OpenSearch, and the mock
processor have Compose health checks. Use `npm run smoke` for HTTP liveness and
`docker compose --profile tools run --rm verifier` for a semantic cross-store check.

The runtime verifier fails when it finds unfinished webhooks or jobs, dead letters, incomplete
captures or receipts, unbalanced journals, missing Redis/OpenSearch projections, or disagreement
between MinIO objects and PostgreSQL manifests.

## Delivery and recovery

- API transactions persist domain rows and outbox events atomically.
- Several publisher replicas may compete safely using row locks and `SKIP LOCKED`.
- Kafka consumers deduplicate with `operations.inbox_events` before changing projections.
- Provider webhooks are signature-checked and deduplicated by provider event ID.
- Document jobs use exponential retry and retain each attempt.
- Terminal webhook or job failures are copied to `operations.dead_letters` for operator review.
- Redis and OpenSearch are disposable projections. Replaying the domain topic rebuilds them.

## Provider sandbox scenarios

The local provider sandbox uses payment-method tokens to make development flows deterministic. A
token beginning with `tok_sandbox_decline_` produces a declined payment; one beginning with
`tok_sandbox_timeout_` persists the provider operation but returns an unavailable response before
its later webhook. Add `_duplicate_` to exercise duplicate delivery, or `_out_of_order_` to deliver
an obsolete `payment.processing` webhook after the terminal event. These tokens are local sandbox
fixtures only; production provider adapters use their provider's test-mode facilities instead.
- Privacy requests checkpoint an explicit participant registry. Completed steps are not repeated
  after a participant failure, and stale customer events are suppressed by a minimal durable
  erased-subject record.

## Privacy recovery

The public request status must remain `failed` while a required dependency is unavailable. The
worker retries with bounded backoff and resumes from its stored participant checkpoints. Do not
manually mark a request completed. Restore the failed dependency and inspect the request through
`GET /v1/erasure-requests/:id`.

## Financial incident checks

Run the verifier first. For manual inspection, group ledger postings by entry and sum debits as
positive and credits as negative; every result must be zero. Captures and refunds are new journal
entries and existing postings cannot be updated or deleted because a database trigger rejects the
operation.

## Resetting a local environment

`docker compose down` stops containers while retaining volumes. Removing volumes destroys the
local PostgreSQL, Redis, Redpanda, MinIO, and OpenSearch data and should only be done when a full
local reset is intended.
