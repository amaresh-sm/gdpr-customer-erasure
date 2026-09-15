import type pg from 'pg';
import { advisoryLock, transaction } from '../../database/src/pool.js';
import { customerFingerprint, ERASURE_IDEMPOTENCY_SCOPE } from './idempotency.js';
import {
  customerExists,
  findRequestById,
  findRequestForCustomer,
  insertRequest,
  recordAudit,
  requeueRequest,
  serializeErasureRequest,
  type ErasureRequestRow,
  type ErasureRequestView,
} from './repository.js';

function notFound(): Error {
  return Object.assign(new Error('erasure_request_not_found'), { statusCode: 404 });
}

/**
 * Binds an idempotency key to one subject. A key already bound to a different customer is
 * rejected so a mistyped key can never redirect a deletion at the wrong person.
 */
async function bindIdempotencyKey(
  client: pg.PoolClient,
  merchantId: string,
  key: string,
  customerId: string,
): Promise<void> {
  const fingerprint = customerFingerprint(customerId);
  const inserted = await client.query(
    `INSERT INTO operations.idempotency_keys(merchant_id,scope,key,request_hash,expires_at)
     VALUES($1,$2,$3,$4,now()+interval '24 hours') ON CONFLICT DO NOTHING`,
    [merchantId, ERASURE_IDEMPOTENCY_SCOPE, key, fingerprint],
  );
  if (inserted.rowCount) return;
  const existing = await client.query<{ request_hash: string }>(
    `SELECT request_hash FROM operations.idempotency_keys
     WHERE merchant_id=$1 AND scope=$2 AND key=$3 FOR UPDATE`,
    [merchantId, ERASURE_IDEMPOTENCY_SCOPE, key],
  );
  if (existing.rows[0]?.request_hash !== fingerprint) {
    throw Object.assign(new Error('idempotency_key_reused_for_different_customer'), { statusCode: 409 });
  }
}

async function completeIdempotency(
  client: pg.PoolClient,
  merchantId: string,
  key: string,
  request: ErasureRequestRow,
): Promise<void> {
  await client.query(
    `UPDATE operations.idempotency_keys SET response_status=202,response_body=jsonb_build_object('id',$4::text)
     WHERE merchant_id=$1 AND scope=$2 AND key=$3`,
    [merchantId, ERASURE_IDEMPOTENCY_SCOPE, key, request.id],
  );
}

/**
 * Accepts a customer data deletion request, or returns the request that already owns the
 * subject. Repeating a request keeps the same request id and resumes it instead of starting
 * a second workflow.
 */
export async function requestCustomerErasure(
  merchantId: string,
  customerId: string,
  idempotencyKey: string,
): Promise<ErasureRequestView> {
  return await transaction(async (client) => {
    await advisoryLock(client, `privacy-erasure:${merchantId}:${customerId}`);
    const existing = await findRequestForCustomer(client, merchantId, customerId);
    if (!existing && !await customerExists(client, merchantId, customerId)) throw notFound();
    await bindIdempotencyKey(client, merchantId, idempotencyKey, customerId);
    if (existing) {
      const resumed = existing.status === 'failed' ? await requeueRequest(client, existing.id) : undefined;
      const request = resumed ?? existing;
      await completeIdempotency(client, merchantId, idempotencyKey, request);
      return serializeErasureRequest(request);
    }
    const created = await insertRequest(client, merchantId, customerId);
    await recordAudit(client, merchantId, customerId, 'privacy.erasure.requested', created.id);
    await completeIdempotency(client, merchantId, idempotencyKey, created);
    return serializeErasureRequest(created);
  });
}

export async function getErasureRequest(merchantId: string, requestId: string): Promise<ErasureRequestView> {
  const request = await findRequestById(merchantId, requestId);
  if (!request) throw notFound();
  return serializeErasureRequest(request);
}
