# Event catalog

All events use an envelope containing `eventId`, `eventType`, `eventVersion`, `occurredAt`,
`aggregateType`, `aggregateId`, `merchantId`, `correlationId`, and `payload`.

Customer events:

- `customer.created.v1`
- `customer.updated.v1`
- `customer.contact.changed.v1`
- `customer.address.changed.v1`
- `customer.payment_method.attached.v1`
- `support.message.created.v1`

Payment events:

- `payment.intent.created.v1`
- `payment.processing.v1`
- `payment.succeeded.v1`
- `payment.failed.v1`
- `payment.cancelled.v1`
- `payment.refunded.v1`
- `payment.disputed.v1`
- `invoice.issued.v1`
- `receipt.generated.v1`

Operational events:

- `notification.requested.v1`
- `projection.rebuild.requested.v1`
- `settlement.imported.v1`
- `reconciliation.completed.v1`

Payload schemas are defined in `packages/contracts` and consumers must ignore unknown additive
fields. Breaking changes require a new event version.
