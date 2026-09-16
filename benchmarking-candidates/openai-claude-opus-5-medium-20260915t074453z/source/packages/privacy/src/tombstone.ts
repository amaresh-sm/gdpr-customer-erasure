import type { PoolClient } from 'pg';
import { pool } from '../../database/src/pool.js';

/**
 * Guards against work that was already in flight when a customer was erased. Delayed jobs, provider
 * callbacks, duplicate webhook deliveries, and Kafka replays (consumers subscribe `fromBeginning`)
 * all carry the customer's details in their payloads, so every write path that could persist those
 * details has to ask whether the customer is erased first.
 */
export async function isCustomerErased(merchantId: string, customerId: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM privacy.erased_customers WHERE merchant_id=$1 AND customer_id=$2`,
    [merchantId, customerId],
  );
  return Boolean(result.rowCount);
}

/**
 * Transactional variant for writers that must decide inside the transaction performing the write.
 * Erasure records the tombstone before it cleans up, so checking under the caller's transaction
 * keeps a concurrent request from committing PII that cleanup has already passed over.
 */
export async function isCustomerErasedIn(
  client: PoolClient,
  merchantId: string,
  customerId: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM privacy.erased_customers WHERE merchant_id=$1 AND customer_id=$2`,
    [merchantId, customerId],
  );
  return Boolean(result.rowCount);
}

/** Resolves erased customers without a merchant scope, for consumers keyed only by customer. */
export async function erasedCustomerIds(customerIds: readonly string[]): Promise<Set<string>> {
  const candidates = customerIds.filter((id) => id.length > 0);
  if (candidates.length === 0) return new Set();
  const result = await pool.query<{ customer_id: string }>(
    `SELECT customer_id FROM privacy.erased_customers WHERE customer_id = ANY($1::uuid[])`,
    [candidates],
  );
  return new Set(result.rows.map((row) => row.customer_id));
}
