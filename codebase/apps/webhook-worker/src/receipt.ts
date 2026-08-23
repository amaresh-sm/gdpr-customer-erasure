import { createHash } from 'node:crypto';
import { DOCUMENT_BUCKET, ensureBucket, objectStore } from '../../../packages/storage/src/minio.js';

export async function storeReceipt(input: {
  merchantId: string; customerId: string; paymentId: string; amount: number; currency: string; customerSnapshot: Record<string, unknown>;
}): Promise<{ objectKey: string; checksum: string }> {
  await ensureBucket();
  const key = `${input.merchantId}/receipts/${input.paymentId}.json`;
  const body = JSON.stringify({
    receiptNumber: input.paymentId, issuedAt: new Date().toISOString(),
    customer: input.customerSnapshot, amount: input.amount, currency: input.currency
  });
  await objectStore.putObject(DOCUMENT_BUCKET, key, body, body.length, { 'Content-Type': 'application/json' });
  return { objectKey: key, checksum: createHash('sha256').update(body).digest('hex') };
}
