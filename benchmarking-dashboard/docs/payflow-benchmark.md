# PayFlow benchmark overview

## The task in one line

Add customer data deletion to PayFlow so a merchant can remove a customer's personal data without losing financial truth or affecting other customers.

## What a candidate receives

Each candidate receives:

- The public task in `instruction/task.md`.
- A private copy of the application in `codebase/`, including its source, package files, Compose setup, migrations, seed data, and candidate-visible documentation.
- The public commands and configuration needed to build and run the application.

The candidate does not receive hidden tests, the reference solution, evaluator code, mutation patches, or other candidate artifacts. The scorer mounts hidden tests only into a separate verifier after the candidate source is frozen.

## PayFlow services and infrastructure

The Compose runtime currently includes:

- `api-gateway`: public HTTP entry point and authentication context.
- `customer-service`: customer data and deletion-request workflow.
- `payment-service`: payment, invoice, ledger, and refund behavior.
- `webhook-worker`: provider webhook consumption and deduplication.
- `projection-worker`: event-driven Redis and OpenSearch projections.
- `notification-worker`: notification and delivery lifecycle.
- `document-worker`: invoice, receipt, and object-storage work.
- `migrator`: database schema migrations.
- PostgreSQL: authoritative relational data and financial records.
- Redis: a cache and short-lived store for customer/payment projections and workflow state.
- Redpanda: event and outbox/inbox transport.
- OpenSearch: a search index for customer and payment projections.
- MinIO: S3-compatible object storage for invoices, receipts, and documents.
- Mailpit: a local mail service that captures notification emails for testing.
- Local provider simulator: deterministic payment outcomes and webhooks.

The repository also contains shared packages for authentication, contracts, database access, messaging, payments, documents, notifications, search, storage, operations, HTTP, configuration, and observability.

## High-level architecture

```text
                         Merchant client
                               |
                               v
                       +--------------------------+
                       | API gateway               |
                       | public HTTP + auth        |
                       +------------+-------------+
                                |
              +-----------------+------------------+
              v                                    v
      +------------------+              +------------------+
      | Customer service |              | Payment service  |
      | deletion workflow|              | payments/refunds |
      +--------+---------+              +--------+---------+
              |                                    |
              +----------------+-------------------+
                               v
                         +-----------------------+
                         | PostgreSQL             |
                         | primary financial DB   |
                         +-----------------------+
                               |
                        outbox/events
                               v
                         +-----------------------+
                         | Redpanda              |
                         | events + outbox       |
                         +-----------+-----------+
                               |
            +------------------+------------------+
            v                  v                 v
     +-------------+    +-------------+   +-------------+
     | Webhook     |    | Projection  |   | Notification|
     | worker      |    | worker      |   | worker      |
     +------+------+    +------+------+   +------+------+
            |                  |                 |
            v                  v                 v
     Provider simulator   Redis/OpenSearch     Mailpit
     payment callbacks    cache + search index local email sink
            |
            v
       payment webhooks

                 Document worker -> MinIO (S3 documents)
```

Deletion is therefore a workflow across the API, relational records, events, workers, caches, search documents, objects, and notifications. Financial records remain usable, while customer-identifying data is removed or anonymized and delayed work is prevented from restoring it.

## Main scenarios checked

- **API safety:** Unknown and cross-merchant customers are hidden, with the correct merchant context enforced.
- **Idempotency and concurrency:** Repeated and concurrent requests share one deletion workflow.
- **PostgreSQL cleanup:** Customer links, embedded PII, jobs, events, and payloads are removed or redacted.
- **External-store cleanup:** Redis, OpenSearch, MinIO, and Mailpit no longer retain customer PII.
- **Financial preservation:** Payments, invoices, and ledger facts remain correct without identifying the deleted customer.
- **Refund behavior:** Later refunds remain usable and balanced without restoring PII.
- **Failure and retry recovery:** Partial failures do not appear complete, and retries continue safely.
- **Delayed asynchronous work:** Pending jobs, notifications, documents, webhooks, and events cannot recreate PII.
- **Historical replay:** Old events are consumed without restoring the deleted customer.
- **Survivor protection:** Unrelated customers, merchants, credentials, payments, notifications, documents, and shared records remain unchanged.

## Score weights, highest to lowest

The normalized score is out of `1.0000`. Checks with the same weight are shown on one row.

| Weight | Checks |
| ---: | --- |
| 0.1000 | Embedded and operational PostgreSQL PII is redacted; Pending work and its payloads are fully sanitized |
| 0.0750 | Financial facts remain intact after a successful erasure; Delayed work does not reintroduce PII; Historical replay does not restore PII |
| 0.0500 | A later refund remains balanced without restoring customer identity; Delayed work completes with correct financial processing; Historical event is safely consumed |
| 0.0375 | Primary relational records are removed or rekeyed; Participant failure prevents completion and the same request converges when retried |
| 0.0313 | Request reaches completed only after convergence; MinIO no longer contains subject PII; Mailpit no longer contains subject PII |
| 0.0250 | Concurrent same-key requests share one workflow; A failed post-erasure refund stays private and a later retry remains balanced; Unrelated customer and shared record remain unchanged; Unrelated payment, notification, and receipt remain unchanged |
| 0.0187 | Alternate key reuses the customer workflow; Redis no longer contains subject PII; OpenSearch no longer contains subject PII |
| 0.0125 | Unknown customer is tenant-safe; Cross-tenant customer and request are hidden without mutation; Idempotent retry returns the original request; Key reuse for another customer is rejected; Retained financial links are anonymous and support a private later refund; Merchant identity and administrator remain unchanged; Independent merchant credential remains active and usable; Delayed-subject deletion request is accepted |

Blocked checks earn no points and are never counted as passes. Zero-weight diagnostics do not affect the normalized score.
