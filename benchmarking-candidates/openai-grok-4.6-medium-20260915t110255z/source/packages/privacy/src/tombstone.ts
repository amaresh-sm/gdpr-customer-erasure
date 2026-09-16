import type pg from 'pg';
import { pool } from '../../database/src/pool.js';

export async function isCustomerErased(merchantId: string, customerId: string | undefined | null): Promise<boolean> {
  if (!customerId) return false;
  const result = await pool.query(
    `SELECT 1 FROM operations.privacy_tombstones WHERE merchant_id=$1 AND customer_id=$2`,
    [merchantId, customerId],
  );
  return Boolean(result.rowCount);
}

export async function isCustomerErasedOn(client: pg.PoolClient, merchantId: string, customerId: string): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM operations.privacy_tombstones WHERE merchant_id=$1 AND customer_id=$2`,
    [merchantId, customerId],
  );
  return Boolean(result.rowCount);
}
