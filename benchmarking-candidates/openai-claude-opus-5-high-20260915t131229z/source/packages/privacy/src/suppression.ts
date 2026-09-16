import type pg from 'pg';
import { pool } from '../../database/src/pool.js';

/**
 * A suppressed customer has an accepted deletion request, so delayed work such
 * as replayed events, provider callbacks, and retried jobs must never write its
 * personal data again.
 */
export async function isCustomerSuppressed(merchantId: string, customerId: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM privacy.erased_customers WHERE merchant_id=$1 AND customer_id=$2`,
    [merchantId, customerId],
  );
  return Boolean(result.rowCount);
}

export async function isCustomerSuppressedInTransaction(
  client: pg.PoolClient,
  merchantId: string,
  customerId: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM privacy.erased_customers WHERE merchant_id=$1 AND customer_id=$2 FOR SHARE`,
    [merchantId, customerId],
  );
  return Boolean(result.rowCount);
}
