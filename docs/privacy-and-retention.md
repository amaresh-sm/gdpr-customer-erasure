# Privacy erasure and retention

PayFlow merchants may request permanent erasure of a customer when the merchant has established a
valid privacy basis. This policy defines the product behavior for the local PayFlow platform. It is
an engineering contract for the application and is not legal advice.

## Data classes

Customer identity, contact details, addresses, external references, payment-method aliases,
provider tokens, free-form customer metadata, uploaded import material, notification destinations,
and customer-facing search or cache documents are erasable personal data.

Payment amounts, currencies, provider transaction identifiers, capture and refund facts, invoice
totals, immutable ledger postings, settlements, and reconciliation results are retained financial
facts. Retaining a financial fact does not justify retaining the customer's name, contact details,
address, payment-method reference, or other unnecessary identity data alongside it.

Audit and analytical facts may be retained only after direct customer identifiers and embedded
personal values have been removed. Security and operational records may keep event type, timestamp,
merchant, status, and non-personal financial measurements.

Financial documents may remain when needed for transaction history, but their customer section
must be redacted. Customer imports and other source documents whose purpose was to create or enrich
a customer record are not retained.

Support conversations can be shared by several customers. Erasure removes the erased customer's
participation, attachments, and personal content without deleting another participant's messages
or the operational ticket record that the other participant still relies on.

## Completion contract

An erasure is complete only when all mutable online copies governed by PayFlow have converged to
the policy above. Completion includes PostgreSQL records and embedded JSON, Redis, OpenSearch,
MinIO documents, pending work, dead letters, notifications, analytics, and other application-owned
projections.

Completion must remain true after duplicate delivery, process restart, retry, a delayed provider
webhook, or replay of an event that was created before erasure. Existing financial processing must
continue without recreating erased personal data.

A minimal durable suppression record may retain the merchant, the supplied internal customer UUID,
an opaque replacement UUID, request identifiers, status, and timestamps. It must not retain the
customer's name, email, phone, address, external reference, payment-method token, or free-form
metadata.

Kafka is a bounded-retention transport rather than an authoritative customer store. Historical log
segments are not rewritten per customer. Consumers must ensure that retained or replayed events
cannot restore personal data after an erasure has completed. PostgreSQL backups, database WAL, and
infrastructure disaster-recovery media are governed by separate expiry and access procedures and
are outside the online erasure operation.

## Isolation and availability

Every request is scoped to the authenticated merchant. A merchant must not be able to learn about
or affect another merchant's customer. Unrelated customers, shared-record survivors, and financial
totals must remain unchanged.

The workflow is durable and retryable. It must not report completion while a required participant
is unavailable or has unfinished work. Repeating the same request, including after a partial
failure, must converge without duplicate destructive side effects.
