import type pg from 'pg';
import { v4 as uuid } from 'uuid';
import type { ErasureRequestSnapshot, ErasureRequestStatus } from '../../../packages/contracts/src/erasure.js';
import { pool, transaction } from '../../../packages/database/src/pool.js';

export interface ErasureRequestRow extends ErasureRequestSnapshot {
  merchant_id: string;
  replacement_id: string;
  idempotency_key: string;
  status: ErasureRequestStatus;
  next_attempt_at: Date;
  locked_by: string | null;
  locked_at: Date | null;
}

export class ErasureRepository {
  async findById(merchantId: string, requestId: string): Promise<ErasureRequestRow | undefined> {
    const result = await pool.query<ErasureRequestRow>(
      `SELECT * FROM customers.erasure_requests WHERE merchant_id=$1 AND id=$2`,
      [merchantId, requestId],
    );
    return result.rows[0];
  }

  private async findByKeyForUpdate(
    client: pg.PoolClient, merchantId: string, key: string,
  ): Promise<ErasureRequestRow | undefined> {
    const result = await client.query<ErasureRequestRow>(
      `SELECT r.* FROM customers.erasure_requests r
       JOIN customers.erasure_request_keys k ON k.request_id=r.id
       WHERE k.merchant_id=$1 AND k.key=$2 FOR UPDATE OF r`,
      [merchantId, key],
    );
    return result.rows[0];
  }

  private async findByCustomerForUpdate(
    client: pg.PoolClient, merchantId: string, customerId: string,
  ): Promise<ErasureRequestRow | undefined> {
    const result = await client.query<ErasureRequestRow>(
      `SELECT * FROM customers.erasure_requests WHERE merchant_id=$1 AND customer_id=$2 FOR UPDATE`,
      [merchantId, customerId],
    );
    return result.rows[0];
  }

  private async recordKey(
    client: pg.PoolClient, merchantId: string, key: string, customerId: string, requestId: string,
  ): Promise<void> {
    await client.query(
      `INSERT INTO customers.erasure_request_keys(merchant_id,key,customer_id,request_id)
       VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [merchantId, key, customerId, requestId],
    );
  }

  /** A failed request is safe to retry: requeue it, preserving its identity and finished work. */
  private async requeueIfFailed(client: pg.PoolClient, row: ErasureRequestRow): Promise<ErasureRequestRow> {
    if (row.status !== 'failed') return row;
    const result = await client.query<ErasureRequestRow>(
      `UPDATE customers.erasure_requests
       SET status='pending',attempts=0,last_error=NULL,next_attempt_at=now(),
           locked_by=NULL,locked_at=NULL,updated_at=now()
       WHERE id=$1 RETURNING *`,
      [row.id],
    );
    return result.rows[0]!;
  }

  /**
   * Starts a new erasure workflow or returns the existing one. Idempotency keys are scoped per
   * merchant: reuse for the same customer replays the same request, reuse for another customer
   * conflicts. The customer is marked as erasing immediately so normal processing stops adding
   * personal data while cleanup runs asynchronously.
   */
  async createOrResume(merchantId: string, customerId: string, key: string): Promise<ErasureRequestRow> {
    return transaction(async (client) => {
      // Existing requests win over customer existence: reposting stays possible after the
      // customer's row has been replaced by the completed cleanup.
      const byKey = await this.findByKeyForUpdate(client, merchantId, key);
      if (byKey) {
        if (byKey.customer_id !== customerId) {
          throw Object.assign(new Error('idempotency_key_reused_for_another_customer'), { statusCode: 409 });
        }
        return await this.requeueIfFailed(client, byKey);
      }

      const byCustomer = await this.findByCustomerForUpdate(client, merchantId, customerId);
      if (byCustomer) {
        await this.recordKey(client, merchantId, key, customerId, byCustomer.id);
        return await this.requeueIfFailed(client, byCustomer);
      }

      const customer = await client.query(
        `SELECT 1 FROM customers.customers WHERE merchant_id=$1 AND id=$2`,
        [merchantId, customerId],
      );
      if (!customer.rowCount) throw Object.assign(new Error('customer_not_found'), { statusCode: 404 });

      const created = await client.query<ErasureRequestRow>(
        `INSERT INTO customers.erasure_requests(merchant_id,customer_id,idempotency_key)
         VALUES($1,$2,$3)
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [merchantId, customerId, key],
      );
      let row = created.rows[0];
      if (!row) {
        // A concurrent request won either the customer slot or the idempotency key.
        const byKeyRetry = await this.findByKeyForUpdate(client, merchantId, key);
        if (byKeyRetry && byKeyRetry.customer_id !== customerId) {
          throw Object.assign(new Error('idempotency_key_reused_for_another_customer'), { statusCode: 409 });
        }
        row = byKeyRetry ?? await this.findByCustomerForUpdate(client, merchantId, customerId);
        if (!row) throw Object.assign(new Error('erasure_request_conflict'), { statusCode: 409 });
        await this.recordKey(client, merchantId, key, customerId, row.id);
        return await this.requeueIfFailed(client, row);
      }
      await this.recordKey(client, merchantId, key, customerId, row.id);
      await client.query(
        `UPDATE customers.customers SET status='erasing',updated_at=now()
         WHERE merchant_id=$1 AND id=$2 AND status='active'`,
        [merchantId, customerId],
      );
      await client.query(
        `INSERT INTO platform.audit_logs(merchant_id,actor_type,target_type,target_id,action,metadata,correlation_id)
         VALUES($1,'api_key','erasure_request',$2,'customer.erasure.requested',$3,$4)`,
        [merchantId, row.id, { requestId: row.id }, uuid()],
      );
      return row;
    });
  }
}
