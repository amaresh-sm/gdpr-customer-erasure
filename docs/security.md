# Security model

Merchant API keys are stored only as SHA-256 hashes and authorize explicit scopes. Every
merchant-facing repository query includes the authenticated merchant ID. Structured HTTP logs
redact authorization headers, API keys, and provider tokens.

Customer erasure requires the dedicated `privacy:erase` scope. Cross-merchant customer and request
identifiers are returned as not found. The privacy worker retains only the raw internal UUID and an
opaque replacement UUID after completion; its temporary subject context is cleared.

Provider webhooks use an HMAC-SHA256 signature with constant-time comparison. Provider event IDs,
API idempotency keys, and consumer event IDs provide separate replay protections at each trust
boundary.

Payment methods contain token references and presentation fields such as brand and last four
digits; the platform does not store raw PAN, CVV, or bank credentials. Local Compose secrets are
development credentials and must be replaced by a secret manager in a deployed environment.

Ledger postings and settlement imports are historical financial evidence. The application uses
append-only entries and compensating transactions instead of modifying financial history.
