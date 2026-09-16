import type pg from 'pg';
import { pool } from '../../../packages/database/src/pool.js';

export interface ErasureRequestRow {
  id: string;
  merchant_id: string;
  customer_id: string;
  job_id: string | null;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  attempts: number;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

export interface AnonymizedIdentity {
  email: string;
  name: string;
  externalReference: string;
}

/** Deterministic, PII-free replacement values so repeated runs converge on the same result. */
export function anonymizedIdentity(customerId: string): AnonymizedIdentity {
  return {
    email: `erased+${customerId}@deleted.payflow.invalid`,
    name: 'Redacted Customer',
    externalReference: `erased-${customerId}`,
  };
}

export class ErasureRepository {
  async findByCustomer(merchantId: string, customerId: string): Promise<ErasureRequestRow | undefined> {
    const result = await pool.query<ErasureRequestRow>(
      `SELECT * FROM customers.erasure_requests WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId],
    );
    return result.rows[0];
  }

  async findById(merchantId: string, requestId: string): Promise<ErasureRequestRow | undefined> {
    const result = await pool.query<ErasureRequestRow>(
      `SELECT * FROM customers.erasure_requests WHERE merchant_id=$1 AND id=$2`,
      [merchantId, requestId],
    );
    return result.rows[0];
  }

  async create(client: pg.PoolClient, merchantId: string, customerId: string): Promise<ErasureRequestRow> {
    const inserted = await client.query<ErasureRequestRow>(
      `INSERT INTO customers.erasure_requests(merchant_id,customer_id,status)
       VALUES($1,$2,'pending')
       ON CONFLICT(merchant_id,customer_id) DO NOTHING
       RETURNING *`,
      [merchantId, customerId],
    );
    if (inserted.rows[0]) return inserted.rows[0];
    const existing = await client.query<ErasureRequestRow>(
      `SELECT * FROM customers.erasure_requests WHERE merchant_id=$1 AND customer_id=$2 FOR UPDATE`,
      [merchantId, customerId],
    );
    return existing.rows[0]!;
  }

  async attachJob(client: pg.PoolClient, requestId: string, jobId: string): Promise<void> {
    await client.query(`UPDATE customers.erasure_requests SET job_id=$2,updated_at=now() WHERE id=$1`, [requestId, jobId]);
  }

  /** Revives a dead job for a repeated deletion request so the workflow can make progress again. */
  async reviveJobIfDead(client: pg.PoolClient, jobId: string | null): Promise<void> {
    if (!jobId) return;
    await client.query(
      `UPDATE operations.jobs SET status='retry',attempts=0,available_at=now(),last_error=NULL
       WHERE id=$1 AND status='dead'`,
      [jobId],
    );
  }

  async markProcessing(client: pg.PoolClient, requestId: string): Promise<void> {
    await client.query(
      `UPDATE customers.erasure_requests SET status='processing',updated_at=now() WHERE id=$1`,
      [requestId],
    );
  }

  async markCompleted(client: pg.PoolClient, requestId: string): Promise<void> {
    await client.query(
      `UPDATE customers.erasure_requests
       SET status='completed',completed_at=now(),last_error=NULL,updated_at=now() WHERE id=$1`,
      [requestId],
    );
  }

  async markFailed(client: pg.PoolClient, requestId: string, errorCode: string): Promise<void> {
    await client.query(
      `UPDATE customers.erasure_requests
       SET status='failed',attempts=attempts+1,last_error=$2,updated_at=now() WHERE id=$1`,
      [requestId, errorCode],
    );
  }
}
