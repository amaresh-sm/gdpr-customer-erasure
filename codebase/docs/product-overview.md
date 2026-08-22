# PayFlow product overview

PayFlow is a production-shaped, multi-tenant payment platform. It models merchant administration,
customers, tokenized payment methods, payment processing, refunds, invoices, immutable ledger
postings, provider webhooks, event-driven projections, object storage, notifications,
reconciliation, and durable privacy operations.

The local deployment is intentionally substantial: five stateful infrastructure systems and
independently running application processes. It is designed for distributed-systems exercises,
not as a single-process demo.

## Local environment

```bash
docker compose up --build -d
docker compose --profile tools run --rm seed
npm run scenario
docker compose --profile tools run --rm verifier
```

The API gateway is available at `http://localhost:3000`. Service and infrastructure ports are
listed in `docker-compose.yml`. Operational procedures and failure semantics are documented in
`docs/operations.md`.
