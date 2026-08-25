# Add customer data deletion to PayFlow

PayFlow is a multi-tenant payment platform used by merchants to manage customers and payments.
Merchants must be able to erase a customer's personal information when required by privacy
regulations. This must be done without damaging financial records, affecting other customers, or
disrupting existing payment operations.

Build customer data deletion for PayFlow.

## User experience

An authenticated merchant should be able to:

- Request deletion of a customer’s personal data.
- Check the status of a data deletion request.
- See a clear outcome if the request cannot be completed.
- Trust that a completed request means the customer's personal information has been deleted.

## Data retention

Some financial records, including payments, invoices, and ledger entries, may need to be retained.
Retained records must preserve their financial meaning while no longer identifying the deleted
customer. PayFlow may keep only the minimal information permitted by its retention policy to track
the deletion and ensure that the customer's information remains deleted.

Follow the API and privacy/retention rules in:

- `docs/privacy-api.md`
- `docs/privacy-and-retention.md`

## API contract

Implement these public API endpoints:

- `POST /v1/customers/:customerId/erasure-requests`
- `GET /v1/erasure-requests/:requestId`

The code repository is at `/workspace`. You are inside a Docker container and may not be able to
perform all the operations you normally would on a local machine. You may need to install
additional dependencies yourself. Work autonomously to complete the task.
