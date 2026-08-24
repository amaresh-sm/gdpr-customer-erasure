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

/** Finds durable suppression whether retained financial data holds the original or surrogate UUID. */
export async function erasedSubjectByAnyId(
  merchantId: string,
  customerId: string,
  client: pg.Pool | pg.PoolClient = pool,
): Promise<{ customerId: string; surrogateId: string } | undefined> {
  const result = await client.query<{ customer_id: string; surrogate_id: string }>(
    `SELECT customer_id,surrogate_id FROM privacy.erased_subjects
     WHERE merchant_id=$1 AND (customer_id=$2 OR surrogate_id=$2)`,
    [merchantId, customerId],
  );
  const row = result.rows[0];
  return row ? { customerId: row.customer_id, surrogateId: row.surrogate_id } : undefined;
}

/** True once erasure suppression has been established, including while cleanup is still running. */
export async function isErasedSubject(
  merchantId: string,
  customerId: string,
  client: pg.Pool | pg.PoolClient = pool,
): Promise<boolean> {
  return (await erasedSubjectSurrogate(merchantId, customerId, client)) !== undefined;
}
