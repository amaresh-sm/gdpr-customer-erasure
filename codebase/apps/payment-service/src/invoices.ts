import { createHash } from 'node:crypto';
import { v4 as uuid } from 'uuid';
import { EVENT_TYPES } from '../../../packages/contracts/src/events.js';
import { config } from '../../../packages/config/src/index.js';
import { transaction } from '../../../packages/database/src/pool.js';
import { addOutboxEvent } from '../../../packages/messaging/src/outbox.js';
import { DOCUMENT_BUCKET, ensureBucket, objectStore } from '../../../packages/storage/src/minio.js';
import { InvoiceRepository, type InvoiceLine } from './invoice-repository.js';

export class InvoiceService {
  constructor(private readonly repository = new InvoiceRepository()) {}

  async create(merchantId: string, authorization: string, input: {
    customerId: string; currency: string; tax: number; lines: InvoiceLine[];
  }): Promise<Record<string, unknown>> {
    const response = await fetch(`${config().CUSTOMER_SERVICE_URL}/v1/customers/${input.customerId}`, { headers: { authorization } });
    if (!response.ok) throw Object.assign(new Error('customer not found'), { statusCode: 422 });
    const customer = await response.json() as Record<string, unknown>;
    const subtotal = input.lines.reduce((sum, line) => sum + line.quantity * line.unitAmount, 0);
    const total = subtotal + input.tax;
    const invoiceId = uuid();
    const number = `INV-${new Date().getUTCFullYear()}-${invoiceId.slice(0, 8).toUpperCase()}`;
    const document = JSON.stringify({
      invoiceId, number, customer, currency: input.currency, subtotal, tax: input.tax, total,
      lines: input.lines, issuedAt: new Date().toISOString()
    });
    await ensureBucket();
    const objectKey = `${merchantId}/invoices/${invoiceId}.json`;
    await objectStore.putObject(DOCUMENT_BUCKET, objectKey, document, Buffer.byteLength(document), { 'Content-Type': 'application/json' });
    await transaction(async (client) => {
      await this.repository.create(client, {
        invoiceId,
        merchantId,
        customerId: input.customerId,
        number,
        currency: input.currency,
        subtotal,
        tax: input.tax,
        total,
        customer,
        objectKey,
        checksum: createHash('sha256').update(document).digest('hex'),
        lines: input.lines,
      });
      await addOutboxEvent(client, {
        eventType: EVENT_TYPES.INVOICE_ISSUED, aggregateType: 'invoice', aggregateId: invoiceId,
        merchantId, correlationId: uuid(), payload: {
          invoiceId, number, customerId: input.customerId,
          customerEmail: customer.email, total, currency: input.currency, objectKey
        }
      });
    });
    return { id: invoiceId, number, status: 'issued', subtotal, tax: input.tax, total, currency: input.currency, objectKey };
  }
}
