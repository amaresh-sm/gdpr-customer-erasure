# Merchant API

All `/v1` routes require `Authorization: Bearer <api-key>`. The key resolves a merchant and a set
of scopes. Resources belonging to another merchant are returned as not found.

## Customer lifecycle

- `POST /v1/customers`
- `GET /v1/customers` and `GET /v1/customers/:id`
- `PATCH /v1/customers/:id` with the current optimistic-lock `version`
- `POST /v1/customers/:id/addresses`
- `POST /v1/customers/:id/contacts`
- `POST /v1/customers/:id/payment-methods`
- `POST /v1/customers/:id/support-tickets`
- `POST /v1/customer-imports`

## Money movement

- `POST /v1/payments` requires an `Idempotency-Key` header and returns `202` while the provider
  webhook is pending.
- `GET /v1/payments` and `GET /v1/payments/:id`
- `POST /v1/payments/:id/refunds`
- `POST /v1/invoices`

Amounts are integer minor units. Currency is a three-letter uppercase ISO-style code. Payment
methods are provider-token references; raw card or bank credentials are never accepted.

## Reconciliation

- `POST /v1/reconciliation/imports` fetches and stores an immutable provider settlement.
- `POST /v1/reconciliation/runs` compares the latest settlement with captured payments.
- `GET /v1/reconciliation/runs/:id` returns matched and mismatched line items.

The seed command prints two local merchant credentials. `npm run scenario` uses the first unless
`PAYFLOW_API_KEY` is provided.
