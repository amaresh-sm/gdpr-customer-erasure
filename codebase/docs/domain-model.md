# Domain model

Merchants own administrators, API keys, customers, payment intents, invoices, and ledger accounts.
Customers can have multiple contacts, addresses, metadata keys, payment-method references, imports,
and participation in shared support tickets.

A payment intent progresses through `requires_payment_method`, `processing`, `succeeded`, `failed`,
or `cancelled`. Attempts and captures are immutable history. Refunds and disputes produce new
ledger transactions; they never rewrite prior postings.

Provider webhooks can be duplicated, delayed, or delivered out of order. The webhook worker records
every delivery in the inbox, locks the corresponding intent, validates the state transition, and
then emits a new outbox event.

Operational work is represented explicitly rather than only in process memory. Outbox events,
provider webhooks, document jobs, and email deliveries move through claim, processing, retry, and
terminal states. Worker claims expire so another process can continue unfinished work after a
restart.
