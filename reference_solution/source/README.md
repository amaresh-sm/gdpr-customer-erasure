# PayFlow

PayFlow is a multi-tenant payment platform for merchants. It supports merchant administration,
customer profiles, tokenized payment methods, payment processing, refunds, invoices, immutable
ledger postings, provider webhooks, event-driven projections, object storage, notifications,
reconciliation, and privacy operations.

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

To exercise provider failure and callback behavior after the environment and seed data are ready:

```bash
npm run provider:check
```

`npm run smoke` checks the gateway and key service health endpoints. `runtime-check` confirms the
sample payment activity converged: outbox publishing, provider callbacks, webhooks, background
jobs, and email delivery have finished; no dead letters remain; ledger entries balance;
reconciliation matches; successful payments have captures and receipts; and Redis, OpenSearch,
MinIO, and Mailpit agree with the database.

The API gateway is available at `http://localhost:3000`. Service and infrastructure ports are
listed in `docker-compose.yml`.

## Documentation

- `docs/privacy-api.md` — customer-erasure API
- `docs/privacy-and-retention.md` — privacy and retention rules
