import { advisoryLock, transaction } from '../../../../packages/database/src/pool.js';
import type { ErasureRequestRecord } from '../../../../packages/privacy/src/types.js';

/** Establishes durable suppression before any destructive participant runs. */
export async function quiesceSubject(request: ErasureRequestRecord): Promise<void> {
  await transaction(async (client) => {
    await advisoryLock(client, `privacy:${request.merchant_id}:${request.customer_id}`);
    await client.query(
      `INSERT INTO privacy.erased_subjects(merchant_id,customer_id,surrogate_id,erasure_request_id)
       VALUES($1,$2,$3,$4) ON CONFLICT(merchant_id,customer_id) DO NOTHING`,
      [request.merchant_id, request.customer_id, request.surrogate_id, request.id],
    );
    await client.query(
      `UPDATE customers.customers SET status='erasure_pending',version=version+1,updated_at=now()
       WHERE merchant_id=$1 AND id=$2 AND status<>'erasure_pending'`,
      [request.merchant_id, request.customer_id],
    );
  });
}
