import type { PoolClient } from 'pg';
import { pool } from '../../database/src/pool.js';

export async function lockCustomerPrivacy(
  client: PoolClient,
  merchantId: string,
  customerId: string,
): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended($1,hashtext($2)))`,
    [merchantId, customerId],
  );
}

export async function customerIsErased(
  client: PoolClient,
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
  const result = await pool.query(
    `SELECT 1 FROM customers.erasure_tombstones WHERE merchant_id=$1 AND customer_id=$2`,
    [merchantId, customerId],
  );
  return Boolean(result.rowCount);
}
