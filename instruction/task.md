# Implement customer erasure in PayFlow
PayFlow is a multi-tenant payment platform. Customer information is used across the application, including payment operations, notifications, background processing, and supporting data stores.

## The problem

PayFlow’s documentation defines a customer-erasure API, but the feature has not been implemented yet.

Build the feature so an authenticated merchant can request erasure of one of its customers and check the request status later. The request and its status must remain reliable if it is retried or if services restart.

Follow the documented API and privacy requirements, and ensure the change does not break existing payment behavior.

## Requirement

Implement these fixed public entry points through the API gateway; do not change their HTTP
methods, paths, authentication model, or response shapes:

- `POST /v1/customers/:customerId/erasure-requests`
- `GET /v1/erasure-requests/:requestId`

The precise API behavior is in `docs/privacy-api.md`, and the erasure/retention contract is in
`docs/privacy-and-retention.md`.

An erasure request can be marked `completed` only after the customer’s personal data has been removed from PayFlow’s active systems and delayed work, retries, webhooks, or replayed events cannot add it back.

Keep valid financial records, such as payments, invoices, and ledger entries, but remove the erased customer’s identifying information from them. Do not affect other customers, merchants, or shared records that they still use.

Repeated requests for the same customer must not create competing erasure workflows. If a request cannot finish, it must not report `completed`.

The original customer UUID is also part of the customer’s identity. After erasure, it must not remain in normal application records, payloads, caches, search documents, files, or object metadata. Remove it, set it to `null`, or replace it with an unrelated opaque UUID where a retained record still needs a reference.

The original UUID may remain only in the minimal erasure-request and suppression records defined by the retention policy. Those records exist only to track the erasure and prevent delayed or replayed work from recreating the erased customer’s data.

## Existing application components

The API gateway entry point is `apps/api-gateway/src/main.ts`.

Privacy, retention, and financial requirements are documented in
`docs/privacy-and-retention.md`.

The codebase includes patterns for database transactions, merchant authentication, outbox/inbox messaging, background workers, and integrations with Redis, OpenSearch, MinIO, and Redpanda. Extend those patterns where appropriate, and keep existing PayFlow behavior working.

## Local verification

Install dependencies and build the application:

```bash
npm ci
npm run build
```

Start the full local PayFlow environment:

```bash
docker compose up --build -d
docker compose --profile tools run --rm seed
```

Run the representative payment scenarios, then confirm the local environment is healthy:

```bash
npm run scenario
docker compose --profile tools run --rm runtime-check
```

These scenarios are representative baseline checks. Ensure your implementation satisfies all
documented requirements while preserving existing PayFlow behavior across its services.
