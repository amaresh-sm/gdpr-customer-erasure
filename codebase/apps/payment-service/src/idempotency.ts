import { createHash } from 'node:crypto';
import type pg from 'pg';

export function requestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export async function reserveIdempotency(
  client: pg.PoolClient,
  merchantId: string,
  scope: string,
  key: string,
  hash: string,
): Promise<{ status: number; body: unknown } | undefined> {
  const inserted = await client.query(
    `INSERT INTO operations.idempotency_keys(merchant_id,scope,key,request_hash,expires_at)
     VALUES($1,$2,$3,$4,now()+interval '24 hours') ON CONFLICT DO NOTHING`,
    [merchantId, scope, key, hash],
  );
  if (inserted.rowCount) return undefined;
  const existing = await client.query<{ request_hash: string; response_status: number | null; response_body: unknown }>(
    `SELECT request_hash,response_status,response_body FROM operations.idempotency_keys
     WHERE merchant_id=$1 AND scope=$2 AND key=$3 FOR UPDATE`, [merchantId, scope, key],
  );
  const row = existing.rows[0];
  if (!row || row.request_hash !== hash) throw Object.assign(new Error('idempotency key reused with different request'), { statusCode: 409 });
  if (row.response_status === null) throw Object.assign(new Error('request with this idempotency key is in progress'), { statusCode: 409 });
  return { status: row.response_status, body: row.response_body };
}

export async function completeIdempotency(
  client: pg.PoolClient, merchantId: string, scope: string, key: string, status: number, body: unknown,
): Promise<void> {
  await client.query(
    `UPDATE operations.idempotency_keys SET response_status=$4,response_body=$5
     WHERE merchant_id=$1 AND scope=$2 AND key=$3`, [merchantId, scope, key, status, body],
  );
}
