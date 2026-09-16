import type pg from 'pg';
import { pool, transaction } from '../../../packages/database/src/pool.js';

export type ErasureStatus = 'pending' | 'processing' | 'failed' | 'completed';

export interface ErasureRequestRow {
  id: string;
  merchant_id: string;
  customer_id: string;
  idempotency_key: string;
  status: ErasureStatus;
  attempts: number;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

export class ErasureRepository {
  async createOrResume(
    merchantId: string,
    customerId: string,
    idempotencyKey: string,
  ): Promise<ErasureRequestRow> {
    return await transaction(async (client) => {
      const byKey = await client.query<ErasureRequestRow>(
        `SELECT r.* FROM privacy.erasure_request_keys k
         JOIN privacy.erasure_requests r ON r.id=k.request_id
         WHERE k.merchant_id=$1 AND k.idempotency_key=$2 FOR UPDATE`,
        [merchantId, idempotencyKey],
      );
      if (byKey.rows[0] && byKey.rows[0].customer_id !== customerId) {
        throw Object.assign(new Error('idempotency key reused with different customer'), { statusCode: 409 });
      }
      if (byKey.rows[0]) return await this.resume(client, byKey.rows[0]);

      const existing = await client.query<ErasureRequestRow>(
        `SELECT * FROM privacy.erasure_requests
         WHERE merchant_id=$1 AND customer_id=$2 FOR UPDATE`,
        [merchantId, customerId],
      );
      if (existing.rows[0]) {
        const resumed = await this.resume(client, existing.rows[0]);
        await client.query(
          `INSERT INTO privacy.erasure_request_keys(merchant_id,idempotency_key,request_id,customer_id)
           VALUES($1,$2,$3,$4)`,
          [merchantId, idempotencyKey, resumed.id, customerId],
        );
        return resumed;
      }

      const customer = await client.query(
        `SELECT 1 FROM customers.customers WHERE merchant_id=$1 AND id=$2`,
        [merchantId, customerId],
      );
      if (!customer.rowCount) throw Object.assign(new Error('customer not found'), { statusCode: 404 });

      const created = await client.query<ErasureRequestRow>(
        `INSERT INTO privacy.erasure_requests
         (merchant_id,customer_id,idempotency_key,status)
         VALUES($1,$2,$3,'pending') RETURNING *`,
        [merchantId, customerId, idempotencyKey],
      );
      const row = created.rows[0]!;
      await client.query(
        `INSERT INTO privacy.erasure_request_keys(merchant_id,idempotency_key,request_id,customer_id)
         VALUES($1,$2,$3,$4)`,
        [merchantId, idempotencyKey, row.id, customerId],
      );
      return row;
    });
  }

  async find(merchantId: string, requestId: string): Promise<ErasureRequestRow | undefined> {
    const result = await pool.query<ErasureRequestRow>(
      `SELECT * FROM privacy.erasure_requests WHERE merchant_id=$1 AND id=$2`,
      [merchantId, requestId],
    );
    return result.rows[0];
  }

  async recoverExpiredLeases(): Promise<number> {
    const result = await pool.query(
      `UPDATE privacy.erasure_requests
       SET status='pending',locked_by=NULL,locked_at=NULL,lease_expires_at=NULL,
           next_attempt_at=now(),last_error=COALESCE(last_error,'erasure_lease_expired'),updated_at=now()
       WHERE status='processing' AND lease_expires_at < now()`,
    );
    return result.rowCount ?? 0;
  }

  async claim(workerId: string): Promise<ErasureRequestRow | undefined> {
    return await transaction(async (client) => {
      const result = await client.query<ErasureRequestRow>(
        `UPDATE privacy.erasure_requests
         SET status='processing',attempts=attempts+1,locked_by=$1,locked_at=now(),
             lease_expires_at=now()+interval '60 seconds',updated_at=now()
         WHERE id=(SELECT id FROM privacy.erasure_requests
           WHERE status IN ('pending','failed') AND next_attempt_at<=now()
           ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
         RETURNING *`,
        [workerId],
      );
      return result.rows[0];
    });
  }

  async markFailed(requestId: string, workerId: string, code: string): Promise<void> {
    await pool.query(
      `UPDATE privacy.erasure_requests
       SET status='failed',last_error=$3,next_attempt_at=now()+interval '5 seconds',
           locked_by=NULL,locked_at=NULL,lease_expires_at=NULL,updated_at=now()
       WHERE id=$1 AND locked_by=$2`,
      [requestId, workerId, code],
    );
  }

  async markCompleted(requestId: string, workerId: string): Promise<void> {
    await pool.query(
      `UPDATE privacy.erasure_requests
       SET status='completed',last_error=NULL,completed_at=now(),updated_at=now(),
           locked_by=NULL,locked_at=NULL,lease_expires_at=NULL
       WHERE id=$1 AND locked_by=$2`,
      [requestId, workerId],
    );
  }

  private async resume(client: pg.PoolClient, request: ErasureRequestRow): Promise<ErasureRequestRow> {
    if (request.status !== 'failed') return request;
    const resumed = await client.query<ErasureRequestRow>(
      `UPDATE privacy.erasure_requests
       SET status='pending',next_attempt_at=now(),last_error=NULL,updated_at=now()
       WHERE id=$1 RETURNING *`,
      [request.id],
    );
    return resumed.rows[0]!;
  }
}

export function erasureResponse(row: ErasureRequestRow): Record<string, unknown> {
  return {
    id: row.id,
    customerId: row.customer_id,
    status: row.status,
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    lastError: row.last_error,
  };
}
