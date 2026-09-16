import type pg from 'pg';
import { pool } from '../../database/src/pool.js';

/**
 * A customer is protected once an erasure request exists or its row is no longer active.
 * Protected customers must never have personal data (re)written by normal processing.
 */
export async function isCustomerErasureRequested(
  merchantId: string,
  customerId: string,
  client?: pg.PoolClient,
): Promise<boolean> {
  const result = await (client ?? pool).query<{ protected: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM customers.erasure_requests WHERE merchant_id=$1 AND customer_id=$2)
       OR EXISTS(SELECT 1 FROM customers.customers WHERE merchant_id=$1 AND id=$2 AND status<>'active') AS protected`,
    [merchantId, customerId],
  );
  return result.rows[0]?.protected ?? false;
}
