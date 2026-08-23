# PayFlow

PayFlow is a multi-tenant payment platform for merchants. It supports customer profiles,
tokenized payment methods, payment processing, refunds, invoices, ledger postings, provider
webhooks, notifications, reconciliation, and privacy operations.

## Local development

Install dependencies and build the application:

```bash
npm ci
npm run build
```

Start the local environment, seed it with development data, and run an ordinary payment flow:

```bash
docker compose up --build -d
docker compose --profile tools run --rm seed
npm run scenario
```

Check that the local services are available:

```bash
npm run smoke
docker compose --profile tools run --rm runtime-check
```

The API gateway is available at `http://localhost:3000`. Service and infrastructure ports are
listed in `docker-compose.yml`.

## Documentation

- `docs/product-overview.md` — product overview and local environment
- `docs/architecture.md` — service boundaries and data flow
- `docs/domain-model.md` — core data model
- `docs/event-catalog.md` — application events and consumers
- `docs/api.md` — existing public APIs
- `docs/privacy-api.md` — customer-erasure API
- `docs/privacy-and-retention.md` — privacy and retention rules
- `docs/operations.md` — operational procedures
- `docs/financial-invariants.md` — financial correctness rules
- `docs/security.md` — authentication and tenant isolation
- `docs/runtime-checks.md` — local runtime checks
