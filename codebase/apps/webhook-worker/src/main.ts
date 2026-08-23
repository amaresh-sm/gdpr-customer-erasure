import { createHmac, timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import { z } from 'zod';
import { config } from '../../../packages/config/src/index.js';
import { pool } from '../../../packages/database/src/pool.js';
import { registerErrorHandler } from '../../../packages/http/src/errors.js';
import { logger } from '../../../packages/observability/src/logger.js';
import { processProviderEvent } from './processor.js';

process.env.SERVICE_NAME = 'webhook-worker';
const eventSchema = z.object({ id: z.string().min(5), type: z.string().min(3), createdAt: z.string().datetime(), data: z.record(z.unknown()) });
const app = Fastify({
  logger: {
    level: config().LOG_LEVEL, base: { service: 'webhook-worker' },
    redact: ['req.headers.authorization', '*.apiKey', '*.providerToken']
  }
});
registerErrorHandler(app);
app.get('/health', async () => ({ status: 'ok', service: 'webhook-worker' }));
app.post('/provider/webhooks', async (request, reply) => {
  const event = eventSchema.parse(request.body);
  const supplied = String(request.headers['x-payflow-signature'] ?? '');
  const expected = createHmac('sha256', config().PROCESSOR_WEBHOOK_SECRET).update(JSON.stringify(event)).digest('hex');
  const valid = supplied.length === expected.length && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
  if (!valid) return reply.code(401).send({ error: 'invalid_signature' });
  await pool.query(
    `INSERT INTO operations.provider_webhooks(provider_event_id,event_type,signature,payload)
     VALUES($1,$2,$3,$4) ON CONFLICT(provider_event_id) DO NOTHING`, [event.id, event.type, supplied, event],
  );
  return reply.code(202).send({ accepted: true });
});

const controller = new AbortController();
async function run(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    const result = await pool.query<{ id: string; payload: z.infer<typeof eventSchema>; attempts: number }>(
      `UPDATE operations.provider_webhooks SET status='processing',attempts=attempts+1
       WHERE id=(SELECT id FROM operations.provider_webhooks WHERE status IN ('pending','retry') AND next_attempt_at<=now()
       ORDER BY received_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id,payload,attempts`,
    );
    const row = result.rows[0];
    if (!row) { await new Promise((resolve) => setTimeout(resolve, 250)); continue; }
    try { await processProviderEvent(row.id, row.payload); }
    catch (error) {
      logger.error({ error, webhookId: row.id }, 'provider webhook processing failed');
      if (row.attempts >= 8) {
        await pool.query(`WITH failed AS (UPDATE operations.provider_webhooks SET status='dead' WHERE id=$1 RETURNING *)
          INSERT INTO operations.dead_letters(source,source_id,event_type,payload,error)
          SELECT 'provider_webhook',id::text,event_type,payload,$2 FROM failed`, [row.id, error instanceof Error ? error.message : String(error)]);
      } else {
        await pool.query(`UPDATE operations.provider_webhooks SET status='retry',next_attempt_at=now()+($2 || ' seconds')::interval WHERE id=$1`,
          [row.id, Math.min(60, 2 ** row.attempts)]);
      }
    }
  }
}
void run(controller.signal);
await app.listen({ host: '0.0.0.0', port: 3010 });
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { controller.abort(); void app.close(); });
