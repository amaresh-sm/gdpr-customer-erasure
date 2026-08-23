# Runtime checks

After starting the local environment and running `npm run scenario`, use the following commands
to check the application state:

```bash
npm run smoke
docker compose --profile tools run --rm runtime-check
```

`npm run smoke` checks the health endpoints for the gateway and key application services.

`runtime-check` checks that the sample payment activity was processed consistently. It confirms
that outbox publishing, provider callbacks, webhooks, background jobs, and email delivery have
finished; no dead letters remain; ledger entries balance; reconciliation matches; successful
payments have captures and receipts; and the Redis, OpenSearch, MinIO, and Mailpit state agrees
with the database.

For recovery procedures and dependency behavior, see `docs/operations.md`.
