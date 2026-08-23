# Runtime checks

After starting the local environment and running `npm run scenario`, use the following commands
to check the application state:

```bash
npm run smoke
npm run check:runtime
```

`npm run smoke` checks the health endpoints for the gateway and key application services.

`npm run check:runtime` checks that the sample payment activity was processed consistently. It
confirms that provider webhooks and background jobs have finished, no dead letters remain, ledger
entries balance, successful payments have captures and receipts, and the Redis, OpenSearch, and
MinIO projections match the database.

For recovery procedures and dependency behavior, see `docs/operations.md`.
