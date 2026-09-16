import type pg from 'pg';
import { pool } from '../../database/src/pool.js';

/**
 * Reports whether a customer has been erased. Consumers use this before writing
 * customer-derived data so delayed or replayed work cannot restore personal data
 * after an erasure request completed.
 */
export async function customerIsErased(merchantId: string, customerId: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM customers.customers WHERE merchant_id=$1 AND id=$2 AND status='erased'`,
    [merchantId, customerId],
  );
  return Boolean(result.rowCount);
}

export async function customerIsErasedInTransaction(
  client: pg.PoolClient,
  merchantId: string,
  customerId: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM customers.customers WHERE merchant_id=$1 AND id=$2 AND status='erased'`,
    [merchantId, customerId],
  );
  return Boolean(result.rowCount);
}
