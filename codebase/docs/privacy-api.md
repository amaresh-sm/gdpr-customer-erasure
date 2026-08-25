# Privacy erasure API

Use the following endpoints to create a customer-erasure request and check its status. After a request is accepted, cleanup runs asynchronously.

## Start or resume an erasure request

```http
POST /v1/customers/{customerId}/erasure-requests
Authorization: Bearer <merchant-api-key>
Idempotency-Key: <8-200 characters>
```

The API key requires the `privacy:erase` scope. The request has no body. A valid request returns
`202 Accepted` with a saved erasure request:

```json
{
  "id": "0ad18e87-1c3f-4af0-aace-345ab19f7a4a",
  "customerId": "147790aa-64d8-4f18-a650-1b3b006ed06e",
  "status": "pending",
  "attempts": 0,
  "createdAt": "2026-08-20T12:00:00.000Z",
  "updatedAt": "2026-08-20T12:00:00.000Z",
  "completedAt": null,
  "lastError": null
}
```

Reusing an idempotency key for the same customer returns the same request. Reusing it for a different customer returns `409 Conflict`. If the customer already has an erasure request, a new key returns that existing request instead of starting another workflow.

For this request-creation endpoint, return `404` if the customer does not exist or belongs to another merchant. Do not reveal information or change data.

## Check an erasure request

```http
GET /v1/erasure-requests/{requestId}
Authorization: Bearer <merchant-api-key>
```

An erasure request has one of these statuses:

- `pending`: accepted and awaiting work.
- `processing`: one or more cleanup steps are running.
- `failed`: the last attempt failed. `lastError` is a stable error code that contains no customer
  data, and the request is safe to retry.
- `completed`: all required cleanup work has finished and delayed work cannot restore PII.

For this status endpoint, return `404` if the erasure request does not exist or belongs to another
merchant.

The service may retry failed requests automatically. Reposting the same request is also allowed. It must keep the same request ID and preserve work that already finished.
