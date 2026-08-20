import { Redis } from 'ioredis';
import { config } from '../../../../packages/config/src/index.js';
import { pool } from '../../../../packages/database/src/pool.js';
import { containsSubjectValue } from '../../../../packages/privacy/src/redact.js';
import type { ErasureRequestRecord, SubjectContext } from '../../../../packages/privacy/src/types.js';
import { CUSTOMER_INDEX, searchClient } from '../../../../packages/search/src/client.js';

function assertZero(label: string, count: number): void {
  if (count !== 0) throw new Error(`verification_failed:${label}`);
}

/** Checks authoritative completion conditions before the public status can become completed. */
export async function verifyCompletion(request: ErasureRequestRecord): Promise<void> {
  const context = request.subject_context as SubjectContext;
  const checks = await Promise.all([
    pool.query(`SELECT 1 FROM customers.customers WHERE merchant_id=$1 AND id=$2`, [request.merchant_id, request.customer_id]),
    pool.query(`SELECT 1 FROM customers.addresses WHERE merchant_id=$1 AND customer_id=$2`, [request.merchant_id, request.customer_id]),
    pool.query(`SELECT 1 FROM customers.contacts WHERE merchant_id=$1 AND customer_id=$2`, [request.merchant_id, request.customer_id]),
    pool.query(`SELECT 1 FROM customers.payment_method_refs WHERE merchant_id=$1 AND customer_id=$2`, [request.merchant_id, request.customer_id]),
    pool.query(`SELECT 1 FROM payments.payment_intents WHERE merchant_id=$1 AND customer_id=$2`, [request.merchant_id, request.customer_id]),
    pool.query(`SELECT 1 FROM payments.invoices WHERE merchant_id=$1 AND customer_id=$2`, [request.merchant_id, request.customer_id]),
    pool.query(`SELECT 1 FROM operations.notification_preferences WHERE merchant_id=$1 AND customer_id=$2`, [request.merchant_id, request.customer_id]),
    pool.query(`SELECT 1 FROM operations.notifications WHERE merchant_id=$1 AND customer_id=$2`, [request.merchant_id, request.customer_id]),
  ]);
  checks.forEach((result, index) => assertZero(`relational_${index}`, result.rowCount ?? 0));

  const payloads = await pool.query<{ value: unknown }>(
    `SELECT payload value FROM operations.outbox_events
       WHERE merchant_id=$1 AND (aggregate_id=$2 OR payload::text LIKE $3)
     UNION ALL SELECT payload value FROM operations.jobs
       WHERE merchant_id=$1 AND payload::text LIKE $3
     UNION ALL SELECT properties value FROM operations.analytics_events
       WHERE merchant_id=$1 AND (anonymous_id=$4 OR properties::text LIKE $3)`,
    [request.merchant_id, request.surrogate_id, `%${request.surrogate_id}%`, `anon_${request.surrogate_id}`],
  );
  if (payloads.rows.some((row) => containsSubjectValue(row.value, context))) {
    throw new Error('verification_failed:operational_payload');
  }

  const redis = new Redis(config().REDIS_URL);
  try {
    const keys = await redis.keys(`merchant:${request.merchant_id}:*${request.customer_id}*`);
    assertZero('redis_subject_keys', keys.length);
  } finally {
    await redis.quit();
  }
  const exists = await searchClient.exists({ index: CUSTOMER_INDEX, id: `${request.merchant_id}:${request.customer_id}` });
  if (exists.body) throw new Error('verification_failed:search_document');
}
