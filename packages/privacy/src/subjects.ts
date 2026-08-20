import type pg from 'pg';
import { pool } from '../../database/src/pool.js';

/** Returns the opaque replacement UUID when a raw customer UUID has an erasure tombstone. */
export async function erasedSubjectSurrogate(
  merchantId: string,
  customerId: string,
  client: pg.Pool | pg.PoolClient = pool,
): Promise<string | undefined> {
  const result = await client.query<{ surrogate_id: string }>(
    `SELECT surrogate_id FROM privacy.erased_subjects WHERE merchant_id=$1 AND customer_id=$2`,
    [merchantId, customerId],
  );
  return result.rows[0]?.surrogate_id;
}

/** True once erasure suppression has been established, including while cleanup is still running. */
export async function isErasedSubject(
  merchantId: string,
  customerId: string,
  client: pg.Pool | pg.PoolClient = pool,
): Promise<boolean> {
  return (await erasedSubjectSurrogate(merchantId, customerId, client)) !== undefined;
}
