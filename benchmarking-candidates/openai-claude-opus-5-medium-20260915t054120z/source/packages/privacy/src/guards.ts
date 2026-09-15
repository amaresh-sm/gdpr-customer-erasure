import type pg from 'pg';
import { pool } from '../../database/src/pool.js';
import { redactedCustomerSnapshot } from './redaction.js';

/**
 * Predicate to append to statements that resolve a customer by `$1` merchant id and `$2`
 * customer id. It keeps ordinary application traffic away from a subject whose deletion has
 * been started, so nothing new is written while the workflow runs or after it finishes.
 */
export const CUSTOMER_NOT_ERASED =
  `NOT EXISTS (SELECT 1 FROM privacy.erased_customers e WHERE e.merchant_id=$1 AND e.customer_id=$2)`;

/** Same predicate for statements that scan customer rows through the alias `c`. */
export const CUSTOMER_ROW_NOT_ERASED =
  `NOT EXISTS (SELECT 1 FROM privacy.erased_customers e WHERE e.merchant_id=c.merchant_id AND e.customer_id=c.id)`;

export async function isErasedCustomer(
  merchantId: string,
  customerId: string,
  client: pg.PoolClient | undefined = undefined,
): Promise<boolean> {
  const executor = client ?? pool;
  const result = await executor.query(
    `SELECT 1 FROM privacy.erased_customers WHERE merchant_id=$1 AND customer_id=$2`,
    [merchantId, customerId],
  );
  return Boolean(result.rowCount);
}

/**
 * Returns the snapshot a replayed or delayed unit of work must use. Deleted subjects always
 * collapse to the redacted snapshot, so retried jobs cannot write personal data back.
 */
export async function snapshotForDelayedWork(
  merchantId: string,
  customerId: string,
  snapshot: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!await isErasedCustomer(merchantId, customerId)) return snapshot;
  return { ...redactedCustomerSnapshot(customerId) };
}
