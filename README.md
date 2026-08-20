# PayFlow Platform

PayFlow is a production-shaped, multi-tenant payment platform. It models merchant administration,
customers, tokenized payment methods, payment processing, refunds, invoices, immutable ledger
postings, provider webhooks, event-driven projections, object storage, notifications, and
reconciliation.

This repository is the ordinary product application. It intentionally contains no privacy-erasure
feature, benchmark harness, reference solution, or candidate task.

The local deployment is intentionally substantial: five stateful infrastructure systems and nine
independently running application processes. It is designed for distributed-systems exercises,
not as a single-process demo.

## Local environment

```bash
docker compose up --build -d
docker compose --profile tools run --rm seed
npm run scenario
docker compose --profile tools run --rm verifier
```

Services:

- API gateway: `http://localhost:3000`
- Customer service: `http://localhost:3001`
- Payment service: `http://localhost:3002`
- Reconciliation service: `http://localhost:3004`
- Mock payment processor: `http://localhost:4000`
- Signed provider-webhook receiver: `http://localhost:3010`
- MinIO console: `http://localhost:9001`
- OpenSearch: `http://localhost:9200`
- Redpanda Kafka: `localhost:9092`

Run checks with `npm test`, `npm run typecheck`, `npm run lint`, and `npm audit --omit=dev`.
Operational procedures and failure semantics are in [docs/operations.md](docs/operations.md).
