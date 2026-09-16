import { createHash } from 'node:crypto';
import { DOCUMENT_BUCKET, ensureBucket, objectStore } from '../../storage/src/minio.js';

export interface ReceiptInput {
  merchantId: string;
  customerId: string;
  paymentId: string;
  amount: number;
  currency: string;
  customerSnapshot: Record<string, unknown>;
}

/** Renders and stores the canonical receipt object for a captured payment. */
export async function storeReceipt(input: ReceiptInput): Promise<{ objectKey: string; checksum: string }> {
  await ensureBucket();
  const objectKey = `${input.merchantId}/receipts/${input.paymentId}.json`;
  const body = JSON.stringify({
    receiptNumber: input.paymentId,
    issuedAt: new Date().toISOString(),
    customer: input.customerSnapshot,
    amount: input.amount,
    currency: input.currency,
  });
  await objectStore.putObject(DOCUMENT_BUCKET, objectKey, body, Buffer.byteLength(body), {
    'Content-Type': 'application/json',
  });
  return { objectKey, checksum: createHash('sha256').update(body).digest('hex') };
}
