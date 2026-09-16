import { randomUUID } from 'node:crypto';
import { transaction } from '../../../packages/database/src/pool.js';
import { completeJob, claimJob, failJob, recoverExpiredJobLeases, type ClaimedJob } from '../../../packages/operations/src/job-lifecycle.js';
import { DOCUMENT_BUCKET, ensureBucket, objectStore } from '../../../packages/storage/src/minio.js';
import { CustomerRepository } from './repository.js';

interface ErasureJob { merchantId: string; customerId: string; requestId: string }
const repository = new CustomerRepository();
const workerId = `privacy-worker-${randomUUID()}`;

async function process(job: ClaimedJob<ErasureJob>): Promise<void> {
  const started = await transaction(async (client) => {
    const result = await client.query(
      `UPDATE customers.erasure_requests SET status='processing',attempts=attempts+1,updated_at=now(),last_error=NULL
       WHERE id=$1 AND merchant_id=$2 AND status IN ('pending','failed') RETURNING id`,
      [job.payload.requestId, job.merchant_id],
    );
    return Boolean(result.rowCount);
  });
  if (!started) {
    await transaction(async (client) => completeJob(client, job));
    return;
  }

  try {
    await ensureBucket();
    const keys = await transaction((client) => repository.erasureObjectKeys(client, job.merchant_id, job.payload.customerId));
    if (keys.length) await objectStore.removeObjects(DOCUMENT_BUCKET, keys);
    await transaction(async (client) => {
      await repository.eraseCustomer(client, job.merchant_id, job.payload.customerId);
      await client.query(
        `UPDATE customers.erasure_requests SET status='completed',completed_at=now(),updated_at=now(),last_error=NULL WHERE id=$1`,
        [job.payload.requestId],
      );
      await completeJob(client, job);
    });
  } catch {
    await transaction(async (client) => {
      await client.query(
        `UPDATE customers.erasure_requests SET status='failed',updated_at=now(),last_error='cleanup_failed' WHERE id=$1`,
        [job.payload.requestId],
      );
      await failJob(client, job, new Error('cleanup_failed'));
    });
  }
}

export async function runErasureWorker(signal: AbortSignal): Promise<void> {
  let lastRecovery = 0;
  while (!signal.aborted) {
    if (Date.now() - lastRecovery > 30_000) {
      await recoverExpiredJobLeases('privacy');
      lastRecovery = Date.now();
    }
    const job = await claimJob<ErasureJob>('privacy', workerId);
    if (!job) { await new Promise((resolve) => setTimeout(resolve, 250)); continue; }
    await process(job);
  }
}
