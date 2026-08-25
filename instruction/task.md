# Implement customer erasure in PayFlow
PayFlow is a multi-tenant payment platform. Customer information is used across the application, including payment operations, notifications, background processing, and supporting data stores.

## The problem

Customer erasure is not implemented yet. The repository includes the API and privacy requirements you must follow.

Implement the feature so an authenticated merchant can erase one of its customers and check the request’s status later. It must work correctly when a request is repeated or when a service restarts. Ensure the change does not break existing payment behavior

## Requirement

Implement the following public endpoints:
- `POST /v1/customers/:customerId/erasure-requests`
- `GET /v1/erasure-requests/:requestId`

Implement without breaking valid payment behavior. Customer data must be erased while required financial history and data belonging to other customers and merchants remain intact. See the linked documents for the full API and retention requirements. The precise API behavior is in `docs/privacy-api.md`, and the erasure/retention contract is in `docs/privacy-and-retention.md`.

## Existing application components

The API gateway entry point is `apps/api-gateway/src/main.ts`.

Privacy, retention, and financial requirements are documented in `docs/privacy-and-retention.md`.

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
