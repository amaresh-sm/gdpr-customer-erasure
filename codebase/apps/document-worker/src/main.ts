import { randomUUID } from 'node:crypto';
import { EVENT_TYPES } from '../../../packages/contracts/src/events.js';
import { transaction } from '../../../packages/database/src/pool.js';
import { startOutboxPublisher } from '../../../packages/messaging/src/publisher.js';
import { logger } from '../../../packages/observability/src/logger.js';
import {
  claimJob,
  completeJob,
  failJob,
  recoverExpiredJobLeases,
  type ClaimedJob,
} from '../../../packages/operations/src/job-lifecycle.js';
import { storeReceipt } from '../../../packages/documents/src/receipt.js';
import { recordReceiptManifest } from './repository.js';

process.env.SERVICE_NAME = 'document-worker';
type ReceiptJob = {
  merchantId: string; customerId: string; paymentId: string; amount: number;
  currency: string; customerSnapshot: Record<string, unknown>
};
const workerId = `document-worker-${randomUUID()}`;
const controller = new AbortController();

async function complete(job: ClaimedJob<ReceiptJob>): Promise<void> {
  const stored = await storeReceipt(job.payload);
  await transaction(async (client) => {
    await recordReceiptManifest(client, {
      merchantId: job.merchant_id,
      customerId: job.payload.customerId,
      paymentId: job.payload.paymentId,
      objectKey: stored.objectKey,
      checksum: stored.checksum,
    });
    await addReceiptEvent(client, job, stored.objectKey);
    await completeJob(client, job);
  });
}

async function addReceiptEvent(client: import('pg').PoolClient, job: ClaimedJob<ReceiptJob>, objectKey: string): Promise<void> {
  const { addOutboxEvent } = await import('../../../packages/messaging/src/outbox.js');
  await addOutboxEvent(client, {
    eventType: EVENT_TYPES.RECEIPT_GENERATED, aggregateType: 'payment_intent',
    aggregateId: job.payload.paymentId, merchantId: job.merchant_id, correlationId: randomUUID(),
    payload: { paymentId: job.payload.paymentId, customerId: job.payload.customerId, objectKey }
  });
}

async function run(signal: AbortSignal): Promise<void> {
  let lastLeaseRecovery = 0;
  while (!signal.aborted) {
    if (Date.now() - lastLeaseRecovery > 30_000) {
      await recoverExpiredJobLeases('documents');
      lastLeaseRecovery = Date.now();
    }
    const job = await claimJob<ReceiptJob>('documents', workerId);
    if (!job) { await new Promise((resolve) => setTimeout(resolve, 250)); continue; }
    try { await complete(job); }
    catch (error) {
      logger.error({ error, jobId: job.id }, 'document job failed');
      await transaction(async (client) => await failJob(client, job, error));
    }
  }
}

void startOutboxPublisher(controller.signal);
void run(controller.signal);
logger.info({ workerId }, 'document worker started');
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => controller.abort());
