# PayFlow product overview

PayFlow is a multi-tenant payment platform for merchants. It supports merchant administration,
customer profiles, tokenized payment methods, payment processing, refunds, invoices, ledger
postings, provider webhooks, event-driven projections, object storage, notifications,
reconciliation, and privacy operations.

The local development environment runs the application as separate services alongside the
infrastructure it depends on.

## Local environment

```bash
docker compose up --build -d
docker compose --profile tools run --rm seed
npm run scenario
```

The API gateway is available at `http://localhost:3000`. Service and infrastructure ports are listed in `docker-compose.yml`.
