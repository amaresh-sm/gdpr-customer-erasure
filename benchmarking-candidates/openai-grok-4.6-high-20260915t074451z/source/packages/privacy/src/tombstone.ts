import type { PoolClient } from 'pg';
import { pool } from '../../database/src/pool.js';

type Queryable = Pick<PoolClient, 'query'> | typeof pool;

/** True when a merchant has already accepted deletion for this customer. */
export async function isErased(
  merchantId: string,
  customerId: string,
  client: Queryable = pool,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM customers.erasure_tombstones WHERE merchant_id=$1 AND customer_id=$2`,
    [merchantId, customerId],
  );
  return Boolean(result.rowCount);
}
