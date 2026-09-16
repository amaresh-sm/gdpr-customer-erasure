import { pool } from '../../database/src/pool.js';

export async function isCustomerErased(
  merchantId: string,
  customerId: string | null | undefined,
): Promise<boolean> {
  if (!customerId) return false;
  const result = await pool.query(
    `SELECT 1 FROM customers.erasure_tombstones WHERE merchant_id=$1 AND customer_id=$2`,
    [merchantId, customerId],
  );
  return Boolean(result.rowCount);
}
