# Privacy erasure API

Privacy erasure is an asynchronous merchant operation exposed through the API gateway.

## Create or resume an erasure request

```http
POST /v1/customers/{customerId}/erasure-requests
Authorization: Bearer <merchant-api-key>
Idempotency-Key: <8-200 characters>
```

The API key requires the `privacy:erase` scope. The request has no body. A valid request returns
`202 Accepted` with the durable request resource:

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

Reusing an idempotency key for the same customer returns the same request. Reusing it for a
different customer returns `409 Conflict`. A second key for a customer with an existing erasure
returns that customer's existing request rather than starting a competing workflow.

An absent customer returns `404`. Cross-merchant identifiers are intentionally indistinguishable
from absent identifiers and also return `404` without mutation.

## Inspect an erasure request

```http
GET /v1/erasure-requests/{requestId}
Authorization: Bearer <merchant-api-key>
```

The response uses one of these public states:

- `pending`: accepted and awaiting work.
- `processing`: one or more required participants are running.
- `failed`: the last attempt failed; `lastError` is a stable non-sensitive error code and the
  request remains safe to retry.
- `completed`: every required participant has converged and delayed work cannot restore PII.

Requests belonging to another merchant return `404`.

The service may retry failed requests automatically. Reposting the same request is also allowed and
must preserve its identity and completed work.
