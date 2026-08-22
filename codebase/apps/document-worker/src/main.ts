import { randomUUID } from 'node:crypto';
import { EVENT_TYPES } from '../../../packages/contracts/src/events.js';
import { transaction } from '../../../packages/database/src/pool.js';
import { startOutboxPublisher } from '../../../packages/messaging/src/publisher.js';
import { logger } from '../../../packages/observability/src/logger.js';
import { storeReceipt } from '../../webhook-worker/src/receipt.js';

process.env.SERVICE_NAME = 'document-worker';
type ReceiptJob = { merchantId: string; customerId: string; paymentId: string; amount: number;
  currency: string; customerSnapshot: Record<string, unknown> };
type Job = { id: string; merchant_id: string; payload: ReceiptJob; attempts: number; max_attempts: number };
const workerId = `document-worker-${randomUUID()}`;
const controller = new AbortController();

async function claim(): Promise<(Job & { attemptId: string }) | undefined> {
  return await transaction(async (client) => {
    const result = await client.query<Job>(
      `UPDATE operations.jobs SET status='processing',attempts=attempts+1,locked_by=$1,locked_at=now()
       WHERE id=(SELECT id FROM operations.jobs WHERE queue='documents' AND status IN ('pending','retry')
       AND available_at<=now() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
       RETURNING id,merchant_id,payload,attempts,max_attempts`, [workerId],
    );
    const job = result.rows[0];
    if (!job) return undefined;
    const attempt = await client.query<{ id: string }>(
      `INSERT INTO operations.job_attempts(job_id,worker_id,status,started_at) VALUES($1,$2,'processing',now()) RETURNING id`,
      [job.id, workerId],
    );
    return { ...job, attemptId: attempt.rows[0]!.id };
  });
}

async function complete(job: Job & { attemptId: string }): Promise<void> {
  const stored = await storeReceipt(job.payload);
  await transaction(async (client) => {
    await client.query(
      `INSERT INTO operations.document_manifests
       (merchant_id,customer_id,object_key,document_type,content_type,checksum,metadata)
       VALUES($1,$2,$3,'receipt','application/json',$4,$5) ON CONFLICT(object_key) DO NOTHING`,
      [job.merchant_id, job.payload.customerId, stored.objectKey, stored.checksum, { paymentId: job.payload.paymentId }],
    );
    await addReceiptEvent(client, job, stored.objectKey);
    await client.query(`UPDATE operations.jobs SET status='completed',locked_by=NULL,locked_at=NULL WHERE id=$1`, [job.id]);
    await client.query(`UPDATE operations.job_attempts SET status='completed',finished_at=now() WHERE id=$1`, [job.attemptId]);
  });
}

async function addReceiptEvent(client: import('pg').PoolClient, job: Job, objectKey: string): Promise<void> {
  const { addOutboxEvent } = await import('../../../packages/messaging/src/outbox.js');
  await addOutboxEvent(client, { eventType: EVENT_TYPES.RECEIPT_GENERATED, aggregateType: 'payment_intent',
    aggregateId: job.payload.paymentId, merchantId: job.merchant_id, correlationId: randomUUID(),
    payload: { paymentId: job.payload.paymentId, customerId: job.payload.customerId, objectKey } });
}

async function fail(job: Job & { attemptId: string }, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await transaction(async (client) => {
    await client.query(`UPDATE operations.job_attempts SET status='failed',error=$2,finished_at=now() WHERE id=$1`, [job.attemptId, message]);
    if (job.attempts >= job.max_attempts) {
      await client.query(`UPDATE operations.jobs SET status='dead',locked_by=NULL,locked_at=NULL WHERE id=$1`, [job.id]);
      await client.query(
        `INSERT INTO operations.dead_letters(source,source_id,event_type,payload,error)
         VALUES('job',$1,'generate_receipt',$2,$3)`, [job.id, job.payload, message],
      );
    } else {
      await client.query(
        `UPDATE operations.jobs SET status='retry',available_at=now()+($2 || ' seconds')::interval,locked_by=NULL,locked_at=NULL WHERE id=$1`,
        [job.id, Math.min(60, 2 ** job.attempts)],
      );
    }
  });
}

async function run(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    const job = await claim();
    if (!job) { await new Promise((resolve) => setTimeout(resolve, 250)); continue; }
    try { await complete(job); }
    catch (error) { logger.error({ error, jobId: job.id }, 'document job failed'); await fail(job, error); }
  }
}

void startOutboxPublisher(controller.signal);
void run(controller.signal);
logger.info({ workerId }, 'document worker started');
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => controller.abort());
