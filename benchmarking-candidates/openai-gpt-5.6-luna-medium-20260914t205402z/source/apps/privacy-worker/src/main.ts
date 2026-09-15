import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { pool, transaction } from '../../../packages/database/src/pool.js';
import { DOCUMENT_BUCKET, objectStore } from '../../../packages/storage/src/minio.js';
import { logger } from '../../../packages/observability/src/logger.js';
import { claimJob, completeJob, failJob, recoverExpiredJobLeases, type ClaimedJob } from '../../../packages/operations/src/job-lifecycle.js';
import { ErasureService } from '../../customer-service/src/erasure.js';

process.env.SERVICE_NAME = 'privacy-worker';
const workerId = `privacy-worker-${randomUUID()}`;
const controller = new AbortController();
const app = Fastify();
app.get('/health', async () => ({ status: 'ok', service: 'privacy-worker' }));
type Payload = { erasureRequestId: string; customerId: string };

async function runOne(job: ClaimedJob<Payload>): Promise<void> {
  const manifests = await pool.query<{ object_key: string }>(
    `SELECT object_key FROM operations.document_manifests WHERE merchant_id=$1 AND customer_id=$2`,
    [job.merchant_id, job.payload.customerId],
  );
  if (manifests.rows.length) await objectStore.removeObjects(DOCUMENT_BUCKET, manifests.rows.map((row) => row.object_key));
  await transaction(async (client) => {
    const result = await client.query<{ status: string; customer_id: string }>(
      `SELECT status,customer_id FROM operations.erasure_requests WHERE id=$1 AND merchant_id=$2 FOR UPDATE`,
      [job.payload.erasureRequestId, job.merchant_id],
    );
    const row = result.rows[0];
    if (!row || row.status === 'completed') return;
    await client.query(`UPDATE operations.erasure_requests SET status='processing',attempts=attempts+1,updated_at=now() WHERE id=$1`, [job.payload.erasureRequestId]);
    await ErasureService.erase(client, job.payload.erasureRequestId, job.merchant_id, row.customer_id);
  });
}

async function run(signal: AbortSignal): Promise<void> {
  let lastRecovery = 0;
  while (!signal.aborted) {
    if (Date.now() - lastRecovery > 30_000) { await recoverExpiredJobLeases('privacy'); lastRecovery = Date.now(); }
    const job = await claimJob<Payload>('privacy', workerId);
    if (!job) { await new Promise((resolve) => setTimeout(resolve, 250)); continue; }
    try {
      await runOne(job);
      await transaction(async (client) => completeJob(client, job));
    } catch (error) {
      logger.error({ error, jobId: job.id }, 'customer erasure failed');
      await transaction(async (client) => {
        await client.query(`UPDATE operations.erasure_requests SET status='failed',last_error='cleanup_failed',updated_at=now() WHERE id=$1 AND status<>'completed'`, [job.payload.erasureRequestId]);
        await failJob(client, job, new Error('cleanup_failed'));
      });
    }
  }
}

void app.listen({ host: '0.0.0.0', port: 3011 });
void run(controller.signal);
logger.info({ workerId }, 'privacy worker started');
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { controller.abort(); void app.close(); });
