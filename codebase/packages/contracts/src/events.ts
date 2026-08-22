import { z } from 'zod';

export const eventEnvelopeSchema = z.object({
  eventId: z.string().uuid(),
  eventType: z.string().min(3),
  eventVersion: z.number().int().positive(),
  occurredAt: z.string().datetime(),
  aggregateType: z.string().min(1),
  aggregateId: z.string().uuid(),
  merchantId: z.string().uuid(),
  correlationId: z.string().uuid(),
  payload: z.record(z.unknown()),
});

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

export const EVENT_TYPES = {
  CUSTOMER_CREATED: 'customer.created.v1',
  CUSTOMER_UPDATED: 'customer.updated.v1',
  CUSTOMER_CONTACT_CHANGED: 'customer.contact.changed.v1',
  CUSTOMER_ADDRESS_CHANGED: 'customer.address.changed.v1',
  PAYMENT_METHOD_ATTACHED: 'customer.payment_method.attached.v1',
  SUPPORT_MESSAGE_CREATED: 'support.message.created.v1',
  PAYMENT_INTENT_CREATED: 'payment.intent.created.v1',
  PAYMENT_PROCESSING: 'payment.processing.v1',
  PAYMENT_SUCCEEDED: 'payment.succeeded.v1',
  PAYMENT_FAILED: 'payment.failed.v1',
  PAYMENT_CANCELLED: 'payment.cancelled.v1',
  PAYMENT_REFUNDED: 'payment.refunded.v1',
  PAYMENT_DISPUTED: 'payment.disputed.v1',
  INVOICE_ISSUED: 'invoice.issued.v1',
  RECEIPT_GENERATED: 'receipt.generated.v1',
  NOTIFICATION_REQUESTED: 'notification.requested.v1',
  SETTLEMENT_IMPORTED: 'settlement.imported.v1',
  RECONCILIATION_COMPLETED: 'reconciliation.completed.v1',
} as const;
