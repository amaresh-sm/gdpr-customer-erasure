# Customer erasure and data retention

PayFlow allows merchants to request erasure of a customer’s personal data. This document explains which data an erasure request must remove, which financial records it must retain, and when the request can be marked complete.

## Customer data and financial records

Customer identity, contact details, addresses, external references, payment-method aliases,
provider customer identifiers and mappings, provider tokens, free-form customer metadata, uploaded import material, notification destinations, and customer-facing search or cache documents are personal data that must be erased.

Payment amounts, currencies, provider transaction identifiers, capture and refund facts, invoice
totals, immutable ledger postings, settlements, and reconciliation results are retained financial
facts. Keeping a financial fact does not allow PayFlow to keep the customer's name, contact
details, address, payment-method reference, or other unnecessary identity data alongside it.

Audit and analytics records may remain only after direct customer identifiers and embedded personal
data have been removed. Security and operational records may keep an event type, timestamp,
merchant, status, and non-personal financial measurements.

Financial documents may remain when needed for transaction history, but their customer section
must be redacted. Customer imports and other source documents used to create or enrich a customer
record are not retained.

## Financial records to keep

- Every ledger transaction has postings whose signed sum is zero.
- Ledger postings are append-only.
- A provider capture can create at most one payment ledger transaction.
- A provider refund can create at most one refund ledger transaction.
- Total successful refunds cannot exceed the captured amount.
- A retained provider payment or capture reference may be used only to process refunds, reconciliation, or other required financial operations. It must not be used to look up, restore, or recreate the erased customer’s identity, payment-method alias, provider customer identifier, or personal data.
- Reconciliation reads immutable provider settlements and ledger postings.
- Customer and projection lifecycle changes cannot alter ledger totals.

Support conversations can involve several customers. Erasure removes the erased customer's
participation, attachments, and personal content without deleting another participant's messages or
the ticket record they still need.

## When erasure is complete

An erasure is complete only after PayFlow has removed the customer's personal data from every active
system it owns. This includes PostgreSQL records and embedded JSON, Redis, OpenSearch, MinIO
documents, pending work, dead letters, notification delivery records, the PayFlow-controlled Mailpit
mailbox, analytics, and other derived data.

The customer must stay erased after duplicate delivery, a process restart, a retry, a delayed
provider webhook, or replay of an event created before erasure. Existing financial processing must
continue without bringing customer data back.

A small permanent suppression record may keep the merchant, the supplied internal customer UUID, an
opaque replacement UUID, request identifiers, status, and timestamps. It must not keep the
customer's name, email, phone, address, external reference, payment-method token, or free-form
metadata.

After completion, the original customer UUID may appear only in the erasure-request and suppression
records described above. Every other PayFlow record must either delete the original UUID, set it to
`null`, or replace it with the opaque replacement UUID when a retained record still needs a link.
This applies to retained payments, invoices, audits, jobs, notifications, analytics, document
manifests, caches, search data, object metadata, and queued, retried, or provider-captured email.
A redacted customer row that still uses the original UUID is not a suppression record and does not
satisfy this policy.

Redpanda keeps events for a limited time. It is not PayFlow's main customer database, so historical
event segments are not rewritten for one customer. Consumers must make sure retained or replayed
events cannot restore personal data after erasure. PostgreSQL backups, database WAL, and
disaster-recovery media follow separate expiry and access procedures and are outside this online
erasure operation.

Mailpit represents the PayFlow-controlled captured-mail archive used in this local environment. Its
messages must be removed or made free of the erased customer's data before completion. PayFlow
cannot delete a message that has already reached an independent recipient mailbox.

## Merchant boundaries and retries

Every request belongs to the authenticated merchant. A merchant must not be able to learn about or
affect another merchant's customer. Unrelated customers, shared records, and financial totals must
remain unchanged.

The erasure workflow must survive retries and restarts. It must not report `completed` while a
required service is unavailable or still has work to do. Repeating a request after a partial failure
must finish the same erasure without repeating cleanup work or changing unrelated data.
