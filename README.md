# Implement durable customer erasure in PayFlow

You maintain PayFlow, a production-shaped, multi-tenant payment platform whose customer identity
is propagated through synchronous services, asynchronous workers, and several storage systems.

## The problem

PayFlow publishes a customer-erasure API contract, but the application does not yet carry out that
contract. Implement it so an authenticated merchant can request erasure and observe durable
progress. The behavior must remain correct under duplicate and concurrent requests, process
restarts, dependency failures, delayed jobs and provider webhooks, old event delivery, tenant
boundary probes, and arbitrary customer-supplied text.

## Requirement

Implement these fixed public entry points through the API gateway; do not change their HTTP
methods, paths, authentication model, or response shapes:

- `POST /v1/customers/:customerId/erasure-requests`
- `GET /v1/erasure-requests/:requestId`

The precise API behavior is in `docs/privacy-api.md`, and the erasure/retention contract is in
`docs/privacy-and-retention.md`. A request may report `completed` only when the subject's active
personal data is gone and later in-flight work cannot restore it. Required financial facts and
records belonging to other customers or merchants must remain correct and usable. Failed work must
be observable and capable of converging safely when retried.

## What you're working with

The public HTTP entry point is `apps/api-gateway/src/main.ts`. Service boundaries and data flows are
documented in `docs/architecture.md`, `docs/domain-model.md`, and `docs/event-catalog.md`; operational
and financial constraints are in `docs/operations.md` and `docs/financial-invariants.md`. The
repository already provides PostgreSQL transaction primitives, authenticated merchant context,
outbox/inbox messaging, background-worker patterns, and clients for Redis, OpenSearch, MinIO, and
Kafka. You may add services, migrations, modules, and tests while preserving existing product
behavior.

## Verifying

Run `npm ci`, then `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build`. Start the
full local environment with `docker compose up --build -d`; `npm run scenario` exercises ordinary
payment flows. Passing the visible checks is necessary but not sufficient: the graded suite
exercises the complete public contract and distributed failure conditions described above.
