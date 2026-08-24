# Operations runbook

## Startup and readiness

`docker compose up --build -d` starts infrastructure, applies checksum-protected migrations, and
then starts application services. PostgreSQL, Redis, Redpanda, MinIO, OpenSearch, and the mock
processor have Compose health checks. Use `npm run smoke` for HTTP liveness and
`docker compose --profile tools run --rm runtime-check` after running the local payment scenario
for a cross-store consistency check.

The runtime check fails when it finds unfinished webhooks or jobs, dead letters, incomplete
captures or receipts, unbalanced journals, missing Redis/OpenSearch projections, or disagreement
between MinIO objects and PostgreSQL manifests.

## Delivery and recovery

- API transactions persist domain rows and outbox events atomically.
- Several publisher replicas may compete safely using row locks and `SKIP LOCKED`. Claimed outbox
  rows have expiring leases so a publisher crash cannot strand an event in `publishing`.
- Redpanda consumers deduplicate with `operations.inbox_events` before changing projections.
- Provider webhooks are signature-checked and deduplicated by provider event ID.
- Workers use time-limited leases. An expired lease returns unfinished work to the retry queue so
  a restarted worker can continue it safely.
- Document jobs and email deliveries use bounded exponential retry and retain each attempt.
- Terminal webhook, job, and email-delivery failures are copied to `operations.dead_letters` for
  operator review.
- The local provider persists accepted payments and refunds before acknowledging them. A dispatcher
  settles due work and retries signed callbacks with backoff, including after provider restarts.
- Redis and OpenSearch are disposable projections. Replaying the domain topic rebuilds them.

## Provider sandbox scenarios

The local provider sandbox uses payment-method tokens to make development flows deterministic. A
token beginning with `tok_sandbox_decline_` produces a declined payment; one beginning with
`tok_sandbox_timeout_` persists the provider operation but returns an unavailable response before
its later webhook. Add `_duplicate_` to exercise duplicate delivery, or `_out_of_order_` to deliver
an obsolete `payment.processing` webhook after the terminal event. These tokens are local sandbox
fixtures only; production provider adapters use their provider's test-mode facilities instead.

## Financial incident checks

Run the runtime check first. For manual inspection, group ledger postings by entry and sum debits as
positive and credits as negative; every result must be zero. Captures and refunds are new journal
entries and existing postings cannot be updated or deleted because a database trigger rejects the
operation.

## Resetting a local environment

`docker compose down` stops containers while retaining volumes. Removing volumes destroys the
local PostgreSQL, Redis, Redpanda, MinIO, and OpenSearch data and should only be done when a full
local reset is intended.
