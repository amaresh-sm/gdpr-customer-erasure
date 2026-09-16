import { createHash } from 'node:crypto';
import { Redis } from 'ioredis';
import { config } from '../../../../packages/config/src/index.js';
import { DOCUMENT_BUCKET, objectStore } from '../../../../packages/storage/src/minio.js';
import { CUSTOMER_INDEX, searchClient } from '../../../../packages/search/src/client.js';
import { deleteMailpitMessagesForRecipient } from '../../../../packages/notifications/src/mailpit.js';
import { ErasureStepError } from '../../../../packages/privacy/src/redaction.js';
import { buildErasedCustomerSnapshot } from '../../../../packages/privacy/src/snapshot.js';
import type { InvoiceToRewrite, ReceiptToRewrite } from './repository.js';

const redis = new Redis(config().REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2 });

async function guard<T>(code: 'search_index_unavailable' | 'cache_unavailable' | 'object_storage_unavailable' | 'mail_provider_unavailable', operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new ErasureStepError(code, error);
  }
}

/** Removes the erased customer's projected document from the search index, if present. */
export async function removeCustomerFromSearchIndex(merchantId: string, customerId: string): Promise<void> {
  await guard('search_index_unavailable', async () => {
    try {
      await searchClient.delete({ index: CUSTOMER_INDEX, id: `${merchantId}:${customerId}` });
    } catch (error) {
      const status = (error as { meta?: { statusCode?: number } }).meta?.statusCode;
      if (status !== 404) throw error;
    }
  });
}

/** Removes cached customer projections so a stale cache entry cannot resurface deleted PII. */
export async function removeCustomerFromCache(merchantId: string, customerId: string): Promise<void> {
  await guard('cache_unavailable', async () => {
    const key = `merchant:${merchantId}:customer:${customerId}`;
    await redis.del(key, `${key}:activity`);
  });
}

/** Purges any Mailpit-captured messages addressed to the customer's known email addresses. */
export async function purgeCapturedEmail(targetEmails: string[]): Promise<void> {
  await guard('mail_provider_unavailable', async () => {
    for (const destination of targetEmails) await deleteMailpitMessagesForRecipient(destination);
  });
}

function buildReceiptDocument(receipt: ReceiptToRewrite, customerId: string): string {
  return JSON.stringify({
    receiptNumber: receipt.payment_id,
    customer: buildErasedCustomerSnapshot(customerId),
    amount: Number(receipt.amount),
    currency: receipt.currency,
  });
}

function buildInvoiceDocument(invoice: InvoiceToRewrite, customerId: string, lines: Array<{ description: string; quantity: number; unit_amount: string; total: string }>): string {
  return JSON.stringify({
    invoiceId: invoice.id,
    number: invoice.number,
    customer: buildErasedCustomerSnapshot(customerId),
    currency: invoice.currency,
    subtotal: Number(invoice.subtotal),
    tax: Number(invoice.tax),
    total: Number(invoice.total),
    lines: lines.map((line) => ({ description: line.description, quantity: line.quantity, unitAmount: Number(line.unit_amount) })),
    issuedAt: invoice.issued_at ? invoice.issued_at.toISOString() : null,
  });
}

/** Rewrites a stored receipt object so it no longer contains the customer's identity, keeping amounts intact. */
export async function rewriteReceiptObject(receipt: ReceiptToRewrite, customerId: string): Promise<string> {
  return await guard('object_storage_unavailable', async () => {
    const body = buildReceiptDocument(receipt, customerId);
    await objectStore.putObject(DOCUMENT_BUCKET, receipt.object_key, body, Buffer.byteLength(body), { 'Content-Type': 'application/json' });
    return createHash('sha256').update(body).digest('hex');
  });
}

/** Rewrites a stored invoice object so it no longer contains the customer's identity, keeping financial totals intact. */
export async function rewriteInvoiceObject(
  invoice: InvoiceToRewrite, customerId: string, lines: Array<{ description: string; quantity: number; unit_amount: string; total: string }>,
): Promise<string | undefined> {
  if (!invoice.object_key) return undefined;
  return await guard('object_storage_unavailable', async () => {
    const body = buildInvoiceDocument(invoice, customerId, lines);
    await objectStore.putObject(DOCUMENT_BUCKET, invoice.object_key!, body, Buffer.byteLength(body), { 'Content-Type': 'application/json' });
    return createHash('sha256').update(body).digest('hex');
  });
}

/** Deletes a customer-import artifact that can no longer be traced to a real customer identity. */
export async function deleteObject(objectKey: string): Promise<void> {
  await guard('object_storage_unavailable', async () => {
    try {
      await objectStore.removeObject(DOCUMENT_BUCKET, objectKey);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== 'NotFound' && code !== 'NoSuchKey') throw error;
    }
  });
}

export async function closeErasureExternalConnections(): Promise<void> {
  redis.disconnect();
}
