import type pg from 'pg';
import { pool } from '../../../packages/database/src/pool.js';
import {
  redactedCustomerRecord,
  redactPii,
  type ErasureRequestRow,
} from '../../../packages/privacy/src/redaction.js';

export interface CollectedErasureContext {
  emails: string[];
  importKeys: string[];
  documentKeys: Array<{ objectKey: string; documentType: string }>;
}

export class ErasureRepository {
  async findCustomer(client: pg.PoolClient, merchantId: string, customerId: string): Promise<{ id: string } | undefined> {
    const result = await client.query<{ id: string }>(
      `SELECT id FROM customers.customers WHERE merchant_id=$1 AND id=$2 FOR UPDATE`,
      [merchantId, customerId],
    );
    return result.rows[0];
  }

  async findById(merchantId: string, requestId: string): Promise<ErasureRequestRow | undefined> {
    const result = await pool.query<ErasureRequestRow>(
      `SELECT * FROM operations.erasure_requests WHERE merchant_id=$1 AND id=$2`,
      [merchantId, requestId],
    );
    return result.rows[0];
  }

  async findByCustomer(client: pg.PoolClient, customerId: string): Promise<ErasureRequestRow | undefined> {
    const result = await client.query<ErasureRequestRow>(
      `SELECT * FROM operations.erasure_requests WHERE customer_id=$1 FOR UPDATE`,
      [customerId],
    );
    return result.rows[0];
  }

  async createRequest(client: pg.PoolClient, merchantId: string, customerId: string): Promise<ErasureRequestRow> {
    const created = await client.query<ErasureRequestRow>(
      `INSERT INTO operations.erasure_requests(merchant_id,customer_id,status)
       VALUES($1,$2,'pending') RETURNING *`,
      [merchantId, customerId],
    );
    const request = created.rows[0]!;
    await client.query(
      `INSERT INTO operations.privacy_tombstones(customer_id,merchant_id,erasure_request_id)
       VALUES($1,$2,$3) ON CONFLICT(customer_id) DO NOTHING`,
      [customerId, merchantId, request.id],
    );
    await client.query(
      `INSERT INTO operations.jobs(queue,job_type,merchant_id,payload)
       VALUES('privacy','customer_erasure',$1,$2)`,
      [merchantId, { requestId: request.id, merchantId, customerId }],
    );
    await client.query(
      `UPDATE customers.customers SET status='erasing',updated_at=now()
       WHERE merchant_id=$1 AND id=$2 AND status='active'`,
      [merchantId, customerId],
    );
    return request;
  }

  async requeueFailed(client: pg.PoolClient, request: ErasureRequestRow): Promise<ErasureRequestRow> {
    const updated = await client.query<ErasureRequestRow>(
      `UPDATE operations.erasure_requests
       SET status='pending',updated_at=now(),last_error=NULL
       WHERE id=$1 AND status='failed' RETURNING *`,
      [request.id],
    );
    const row = updated.rows[0] ?? request;
    const existingJob = await client.query<{ id: string }>(
      `SELECT id FROM operations.jobs
       WHERE queue='privacy' AND job_type='customer_erasure' AND payload->>'requestId'=$1
       ORDER BY created_at LIMIT 1`,
      [row.id],
    );
    if (existingJob.rows[0]) {
      await client.query(
        `UPDATE operations.jobs
         SET status='pending',available_at=now(),locked_by=NULL,locked_at=NULL,lease_expires_at=NULL,last_error=NULL
         WHERE id=$1 AND status IN ('dead','retry','pending','processing')`,
        [existingJob.rows[0].id],
      );
    } else {
      await client.query(
        `INSERT INTO operations.jobs(queue,job_type,merchant_id,payload)
         VALUES('privacy','customer_erasure',$1,$2)`,
        [row.merchant_id, { requestId: row.id, merchantId: row.merchant_id, customerId: row.customer_id }],
      );
    }
    return row;
  }

  async markProcessing(requestId: string): Promise<ErasureRequestRow | undefined> {
    const current = await pool.query<ErasureRequestRow>(
      `SELECT * FROM operations.erasure_requests WHERE id=$1`,
      [requestId],
    );
    const existing = current.rows[0];
    if (!existing || existing.status === 'completed') return existing;
    const result = await pool.query<ErasureRequestRow>(
      `UPDATE operations.erasure_requests
       SET status='processing',attempts=attempts+1,updated_at=now(),last_error=NULL
       WHERE id=$1 AND status<>'completed' RETURNING *`,
      [requestId],
    );
    return result.rows[0] ?? existing;
  }

  async markCompleted(client: pg.PoolClient, requestId: string): Promise<void> {
    await client.query(
      `UPDATE operations.erasure_requests
       SET status='completed',completed_at=now(),updated_at=now(),last_error=NULL
       WHERE id=$1`,
      [requestId],
    );
  }

  async markFailed(requestId: string, errorCode: string): Promise<void> {
    await pool.query(
      `UPDATE operations.erasure_requests
       SET status='failed',last_error=$2,updated_at=now()
       WHERE id=$1 AND status<>'completed'`,
      [requestId, errorCode],
    );
  }

  async collectContext(merchantId: string, customerId: string): Promise<CollectedErasureContext> {
    const emails = await pool.query<{ email: string }>(
      `SELECT DISTINCT email FROM (
         SELECT email FROM customers.customers WHERE merchant_id=$1 AND id=$2
         UNION ALL
         SELECT value FROM customers.contacts WHERE merchant_id=$1 AND customer_id=$2 AND kind='email'
         UNION ALL
         SELECT destination FROM operations.notification_preferences WHERE merchant_id=$1 AND customer_id=$2
         UNION ALL
         SELECT destination FROM operations.email_deliveries WHERE merchant_id=$1 AND customer_id=$2
         UNION ALL
         SELECT destination FROM operations.notifications WHERE merchant_id=$1 AND customer_id=$2
         UNION ALL
         SELECT customer_email FROM payments.refunds r
           JOIN payments.payment_intents p ON p.id=r.payment_intent_id
          WHERE p.merchant_id=$1 AND p.customer_id=$2 AND r.customer_email IS NOT NULL
         UNION ALL
         SELECT customer_snapshot->>'email' FROM payments.payment_intents
          WHERE merchant_id=$1 AND customer_id=$2
         UNION ALL
         SELECT billing_snapshot->>'email' FROM payments.invoices
          WHERE merchant_id=$1 AND customer_id=$2
         UNION ALL
         SELECT email FROM operations.analytics_events
          WHERE merchant_id=$1 AND customer_id=$2
       ) addresses WHERE email IS NOT NULL AND email <> '' AND email NOT LIKE 'erased-%'`,
      [merchantId, customerId],
    );
    const imports = await pool.query<{ object_key: string }>(
      `SELECT object_key FROM operations.document_manifests
       WHERE merchant_id=$1 AND document_type='customer_import'`,
      [merchantId],
    );
    const documents = await pool.query<{ object_key: string; document_type: string }>(
      `SELECT object_key,document_type FROM operations.document_manifests
       WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId],
    );
    return {
      emails: emails.rows.map((row) => row.email),
      importKeys: imports.rows.map((row) => row.object_key),
      documentKeys: documents.rows.map((row) => ({ objectKey: row.object_key, documentType: row.document_type })),
    };
  }

  async applyRelationalErasure(client: pg.PoolClient, merchantId: string, customerId: string): Promise<void> {
    const redactedCustomer = redactedCustomerRecord(customerId);

    await client.query(
      `UPDATE customers.customers
       SET email=$3,name=$4,phone=NULL,metadata='{}'::jsonb,external_reference=$5,
           status='erased',version=version+1,updated_at=now()
       WHERE merchant_id=$1 AND id=$2`,
      [merchantId, customerId, redactedCustomer.email, redactedCustomer.name, redactedCustomer.external_reference],
    );
    await client.query(`DELETE FROM customers.addresses WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
    await client.query(`DELETE FROM customers.contacts WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
    await client.query(
      `UPDATE customers.payment_method_refs
       SET billing_name=NULL,billing_address=NULL,status='revoked'
       WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId],
    );

    await this.eraseSupport(client, merchantId, customerId);
    await this.eraseFinancialRecords(client, merchantId, customerId, redactedCustomer);
    await this.eraseOperationalRecords(client, merchantId, customerId);
    await this.eraseProviderProfile(client, merchantId, customerId, redactedCustomer);
  }

  async updateDocumentChecksum(objectKey: string, checksum: string): Promise<void> {
    await pool.query(
      `UPDATE operations.document_manifests SET checksum=$2 WHERE object_key=$1`,
      [objectKey, checksum],
    );
  }

  async deleteImportRecord(objectKey: string): Promise<void> {
    await pool.query(`DELETE FROM customers.customer_imports WHERE object_key=$1`, [objectKey]);
    await pool.query(`DELETE FROM operations.document_manifests WHERE object_key=$1`, [objectKey]);
  }

  private async eraseSupport(client: pg.PoolClient, merchantId: string, customerId: string): Promise<void> {
    const exclusive = await client.query<{ id: string }>(
      `SELECT t.id
       FROM customers.support_tickets t
       JOIN customers.support_participants p ON p.ticket_id=t.id
       WHERE t.merchant_id=$1
       GROUP BY t.id
       HAVING COUNT(*) FILTER (WHERE p.customer_id=$2) > 0
          AND COUNT(*) FILTER (WHERE p.customer_id<>$2) = 0`,
      [merchantId, customerId],
    );
    const exclusiveIds = exclusive.rows.map((row) => row.id);
    if (exclusiveIds.length) {
      await client.query(`DELETE FROM customers.support_messages WHERE ticket_id=ANY($1::uuid[])`, [exclusiveIds]);
      await client.query(`DELETE FROM customers.support_participants WHERE ticket_id=ANY($1::uuid[])`, [exclusiveIds]);
      await client.query(`DELETE FROM customers.support_tickets WHERE id=ANY($1::uuid[])`, [exclusiveIds]);
    }
    await client.query(
      `UPDATE customers.support_messages
       SET body='[redacted]',author_id=NULL,attachments='[]'::jsonb
       WHERE merchant_id=$1 AND author_type='customer' AND author_id=$2`,
      [merchantId, customerId],
    );
    await client.query(
      `DELETE FROM customers.support_participants WHERE customer_id=$1`,
      [customerId],
    );
  }

  private async eraseFinancialRecords(
    client: pg.PoolClient,
    merchantId: string,
    customerId: string,
    redactedCustomer: Record<string, unknown>,
  ): Promise<void> {
    await client.query(
      `UPDATE payments.payment_intents
       SET customer_snapshot=$3,description=NULL,updated_at=now()
       WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId, redactedCustomer],
    );
    await client.query(
      `UPDATE payments.payment_attempts a
       SET request_payload = CASE
         WHEN jsonb_typeof(a.request_payload)='object'
         THEN (a.request_payload - 'description')
         ELSE a.request_payload
       END
       FROM payments.payment_intents p
       WHERE a.payment_intent_id=p.id AND p.merchant_id=$1 AND p.customer_id=$2`,
      [merchantId, customerId],
    );
    await client.query(
      `UPDATE payments.refunds r
       SET customer_email=NULL
       FROM payments.payment_intents p
       WHERE r.payment_intent_id=p.id AND p.merchant_id=$1 AND p.customer_id=$2`,
      [merchantId, customerId],
    );
    await client.query(
      `UPDATE payments.disputes d
       SET evidence='{}'::jsonb
       FROM payments.payment_intents p
       WHERE d.payment_intent_id=p.id AND p.merchant_id=$1 AND p.customer_id=$2`,
      [merchantId, customerId],
    );
    await client.query(
      `UPDATE payments.invoices
       SET billing_snapshot=$3
       WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId, redactedCustomer],
    );
  }

  private async eraseOperationalRecords(client: pg.PoolClient, merchantId: string, customerId: string): Promise<void> {
    await this.redactJsonRows(
      client,
      `SELECT id,payload FROM operations.outbox_events
       WHERE merchant_id=$1 AND (aggregate_id=$2 OR payload->>'customerId'=$2)`,
      `UPDATE operations.outbox_events SET payload=$2 WHERE id=$1`,
      merchantId,
      customerId,
    );
    await this.redactJsonRows(
      client,
      `SELECT id,payload FROM operations.jobs
       WHERE merchant_id=$1 AND payload->>'customerId'=$2`,
      `UPDATE operations.jobs SET payload=$2 WHERE id=$1`,
      merchantId,
      customerId,
    );
    await this.redactJsonRows(
      client,
      `SELECT id,payload FROM operations.dead_letters
       WHERE payload->>'customerId'=$2`,
      `UPDATE operations.dead_letters SET payload=$2 WHERE id=$1`,
      merchantId,
      customerId,
    );
    await this.redactJsonRows(
      client,
      `SELECT id,properties AS payload FROM operations.analytics_events
       WHERE merchant_id=$1 AND customer_id=$2`,
      `UPDATE operations.analytics_events SET properties=$2,email=NULL,anonymous_id='anon_erased' WHERE id=$1`,
      merchantId,
      customerId,
    );
    await this.redactJsonRows(
      client,
      `SELECT id,metadata AS payload FROM platform.audit_logs
       WHERE merchant_id=$1 AND target_id=$2`,
      `UPDATE platform.audit_logs SET metadata=$2 WHERE id=$1`,
      merchantId,
      customerId,
    );
    await client.query(
      `DELETE FROM operations.notification_preferences WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId],
    );
    await client.query(
      `DELETE FROM operations.notifications WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId],
    );
    await client.query(
      `DELETE FROM operations.email_deliveries WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId],
    );
  }

  private async eraseProviderProfile(
    client: pg.PoolClient,
    merchantId: string,
    customerId: string,
    redactedCustomer: Record<string, unknown>,
  ): Promise<void> {
    await client.query(
      `UPDATE provider_sandbox.customers
       SET email=$3,name=$4,external_reference=$5,updated_at=now()
       WHERE merchant_id=$1 AND payflow_customer_id=$2`,
      [merchantId, customerId, redactedCustomer.email, redactedCustomer.name, redactedCustomer.external_reference],
    );
  }

  private async redactJsonRows(
    client: pg.PoolClient,
    selectSql: string,
    updateSql: string,
    merchantId: string,
    customerId: string,
  ): Promise<void> {
    const result = await client.query<{ id: string; payload: unknown }>(selectSql, [merchantId, customerId]);
    for (const row of result.rows) {
      await client.query(updateSql, [row.id, redactPii(row.payload)]);
    }
  }
}
