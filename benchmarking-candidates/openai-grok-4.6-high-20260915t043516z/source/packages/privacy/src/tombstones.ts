import type { PoolClient } from 'pg';
import { pool } from '../../database/src/pool.js';

export async function isCustomerErased(merchantId: string, customerId: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM customers.erasure_tombstones WHERE merchant_id=$1 AND customer_id=$2`,
    [merchantId, customerId],
  );
  return Boolean(result.rowCount);
}

export async function upsertTombstone(
  client: PoolClient, merchantId: string, customerId: string, requestId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO customers.erasure_tombstones(merchant_id,customer_id,request_id)
     VALUES($1,$2,$3) ON CONFLICT(merchant_id,customer_id) DO NOTHING`,
    [merchantId, customerId, requestId],
  );
}
