# Repository notes

- Customer erasure is implemented by `packages/privacy/src/customer-erasure.ts`, with durable request state in migration `009_customer_erasure.sql`.
- A tombstone is created before asynchronous cleanup so delayed workers and event replays cannot recreate customer data.
- Financial rows are retained only after customer references and PII snapshots are redacted; the erasure worker is the single owner of that cleanup.
