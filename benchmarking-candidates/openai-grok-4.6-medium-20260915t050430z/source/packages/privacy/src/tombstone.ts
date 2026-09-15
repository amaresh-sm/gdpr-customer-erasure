import type pg from 'pg';
import { pool } from '../../database/src/pool.js';

type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;

export async function customerIsErased(
  client: Queryable,
  merchantId: string,
  customerId: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM customers.erasure_tombstones WHERE merchant_id=$1 AND customer_id=$2`,
    [merchantId, customerId],
  );
  return Boolean(result.rowCount);
}

export async function customerIsErasedNow(merchantId: string, customerId: string): Promise<boolean> {
  return customerIsErased(pool, merchantId, customerId);
}
