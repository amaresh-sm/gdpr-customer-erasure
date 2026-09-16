import type { PoolClient } from 'pg';
import { pool } from '../../database/src/pool.js';

export async function isCustomerErased(
  merchantId: string,
  customerId: string,
  client?: PoolClient,
): Promise<boolean> {
  const db = client ?? pool;
  const result = await db.query(
    `SELECT 1 FROM operations.erasure_tombstones WHERE merchant_id=$1 AND customer_id=$2`,
    [merchantId, customerId],
  );
  return Boolean(result.rowCount);
}
