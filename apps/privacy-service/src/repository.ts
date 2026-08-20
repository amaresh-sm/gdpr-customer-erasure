import type pg from 'pg';
import { v4 as uuid } from 'uuid';
import { advisoryLock, pool, transaction } from '../../../packages/database/src/pool.js';
import type { ErasureRequestRecord, SubjectContext } from '../../../packages/privacy/src/types.js';
import { PARTICIPANTS } from './workflow.js';

function addString(output: Set<string>, value: unknown): void {
  if (typeof value === 'string' && value.length >= 3) output.add(value);
}

function collectIdentityValues(customer: Record<string, unknown>, related: Array<Record<string, unknown>[]>): string[] {
  const output = new Set<string>();
  for (const field of ['email', 'name', 'phone', 'external_reference']) addString(output, customer[field]);
  for (const row of related.flat()) {
    for (const field of ['value', 'line1', 'line2', 'postal_code', 'provider_token', 'billing_name', 'body']) {
      addString(output, row[field]);
    }
  }
  return [...output];
}

export interface PublicErasureRequest {
  id: string;
  customerId: string;
  status: ErasureRequestRecord['status'];
  attempts: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  lastError: string | null;
}

export class PrivacyRepository {
  async createOrGet(merchantId: string, customerId: string, idempotencyKey: string): Promise<ErasureRequestRecord> {
    return transaction(async (client) => {
      await advisoryLock(client, `privacy:${merchantId}:${customerId}`);
      const keyRequest = await client.query<ErasureRequestRecord>(
        `SELECT * FROM privacy.erasure_requests WHERE merchant_id=$1 AND idempotency_key=$2 FOR UPDATE`,
        [merchantId, idempotencyKey],
      );
      if (keyRequest.rows[0]) {
        if (keyRequest.rows[0].customer_id !== customerId) {
          throw Object.assign(new Error('idempotency key reused for another customer'), { statusCode: 409 });
        }
        return this.resumeIfEligible(client, keyRequest.rows[0]);
      }

      const customerRequest = await client.query<ErasureRequestRecord>(
        `SELECT * FROM privacy.erasure_requests WHERE merchant_id=$1 AND customer_id=$2 FOR UPDATE`,
        [merchantId, customerId],
      );
      if (customerRequest.rows[0]) return this.resumeIfEligible(client, customerRequest.rows[0]);

      const customer = await client.query(
        `SELECT * FROM customers.customers WHERE merchant_id=$1 AND id=$2 FOR UPDATE`, [merchantId, customerId],
      );
      if (!customer.rows[0]) throw Object.assign(new Error('customer not found'), { statusCode: 404 });

      const related = await Promise.all([
        client.query(`SELECT * FROM customers.addresses WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]),
        client.query(`SELECT * FROM customers.contacts WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]),
        client.query(`SELECT * FROM customers.payment_method_refs WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]),
        client.query(`SELECT m.* FROM customers.support_messages m WHERE m.merchant_id=$1 AND m.author_type='customer' AND m.author_id=$2`, [merchantId, customerId]),
      ]);
      const surrogateId = uuid();
      const context: SubjectContext = {
        merchantId,
        customerId,
        surrogateId,
        sensitiveValues: collectIdentityValues(customer.rows[0] as Record<string, unknown>,
          related.map((result) => result.rows as Record<string, unknown>[])),
      };
      const inserted = await client.query<ErasureRequestRecord>(
        `INSERT INTO privacy.erasure_requests
         (merchant_id,customer_id,surrogate_id,idempotency_key,subject_context)
         VALUES($1,$2,$3,$4,$5) RETURNING *`,
        [merchantId, customerId, surrogateId, idempotencyKey, context],
      );
      const request = inserted.rows[0]!;
      for (const [ordinal, participant] of PARTICIPANTS.entries()) {
        await client.query(
          `INSERT INTO privacy.erasure_steps(request_id,participant,ordinal) VALUES($1,$2,$3)`,
          [request.id, participant.name, ordinal + 1],
        );
      }
      await client.query(
        `INSERT INTO platform.audit_logs
         (merchant_id,actor_type,target_type,target_id,action,metadata,correlation_id)
         VALUES($1,'api_key','customer',$2,'privacy.erasure.requested',$3,$4)`,
        [merchantId, customerId, { erasureRequestId: request.id }, request.id],
      );
      return request;
    });
  }

  async find(merchantId: string, requestId: string): Promise<ErasureRequestRecord | undefined> {
    const result = await pool.query<ErasureRequestRecord>(
      `SELECT * FROM privacy.erasure_requests WHERE merchant_id=$1 AND id=$2`, [merchantId, requestId],
    );
    return result.rows[0];
  }

  toPublic(row: ErasureRequestRecord): PublicErasureRequest {
    return {
      id: row.id,
      customerId: row.customer_id,
      status: row.status,
      attempts: row.attempts,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      completedAt: row.completed_at?.toISOString() ?? null,
      lastError: row.last_error,
    };
  }

  private async resumeIfEligible(client: pg.PoolClient, row: ErasureRequestRecord): Promise<ErasureRequestRecord> {
    if (row.status !== 'failed' || row.attempts >= row.max_attempts) return row;
    const resumed = await client.query<ErasureRequestRecord>(
      `UPDATE privacy.erasure_requests
       SET status='pending',next_attempt_at=now(),last_error=NULL,updated_at=now()
       WHERE id=$1 RETURNING *`, [row.id],
    );
    return resumed.rows[0]!;
  }
}
