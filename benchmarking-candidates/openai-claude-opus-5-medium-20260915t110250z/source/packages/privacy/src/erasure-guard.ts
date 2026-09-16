import type { PoolClient } from 'pg';
import { pool } from '../../database/src/pool.js';

/**
 * Reports whether a deletion request retains a tombstone for the customer. Every writer of customer
 * data must consult this before persisting, because retries, provider callbacks, duplicate
 * deliveries, and replayed events can arrive long after the request completed.
 */
export async function isCustomerErased(merchantId: string, customerId: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM privacy.erased_customers WHERE merchant_id=$1 AND customer_id=$2`,
    [merchantId, customerId],
  );
  return Boolean(result.rowCount);
}

/** Checks the tombstone inside a caller's transaction so the decision and the write commit together. */
export async function isCustomerErasedInTransaction(
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
