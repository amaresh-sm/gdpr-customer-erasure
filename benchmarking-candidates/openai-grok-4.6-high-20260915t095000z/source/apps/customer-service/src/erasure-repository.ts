import type pg from 'pg';
import { pool } from '../../../packages/database/src/pool.js';
import { erasedEmail, erasedExternalReference, type ErasureRequestRow } from './erasure-policy.js';

export interface ClaimedErasureRequest extends ErasureRequestRow {
  merchant_id: string;
  max_attempts: number;
}

export class ErasureRepository {
  async findCustomer(client: pg.PoolClient, merchantId: string, customerId: string): Promise<{ id: string; status: string } | undefined> {
    const result = await client.query<{ id: string; status: string }>(
      `SELECT id,status FROM customers.customers WHERE merchant_id=$1 AND id=$2 FOR UPDATE`,
      [merchantId, customerId],
    );
    return result.rows[0];
  }

  async findByCustomer(client: pg.PoolClient, merchantId: string, customerId: string): Promise<ErasureRequestRow | undefined> {
    const result = await client.query<ErasureRequestRow>(
      `SELECT id,merchant_id,customer_id,status,attempts,last_error,created_at,updated_at,completed_at
       FROM operations.erasure_requests WHERE merchant_id=$1 AND customer_id=$2 FOR UPDATE`,
      [merchantId, customerId],
    );
    return result.rows[0];
  }

  async findById(merchantId: string, requestId: string): Promise<ErasureRequestRow | undefined> {
    const result = await pool.query<ErasureRequestRow>(
      `SELECT id,merchant_id,customer_id,status,attempts,last_error,created_at,updated_at,completed_at
       FROM operations.erasure_requests WHERE merchant_id=$1 AND id=$2`,
      [merchantId, requestId],
    );
    return result.rows[0];
  }

  async create(client: pg.PoolClient, merchantId: string, customerId: string): Promise<ErasureRequestRow> {
    const created = await client.query<ErasureRequestRow>(
      `INSERT INTO operations.erasure_requests(merchant_id,customer_id,status)
       VALUES($1,$2,'pending') RETURNING id,merchant_id,customer_id,status,attempts,last_error,created_at,updated_at,completed_at`,
      [merchantId, customerId],
    );
    const request = created.rows[0]!;
    await client.query(
      `INSERT INTO operations.erasure_tombstones(merchant_id,customer_id,erasure_request_id)
       VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
      [merchantId, customerId, request.id],
    );
    await client.query(
      `UPDATE customers.customers SET status='erased',updated_at=now() WHERE merchant_id=$1 AND id=$2`,
      [merchantId, customerId],
    );
    return request;
  }

  async requeue(client: pg.PoolClient, requestId: string): Promise<ErasureRequestRow> {
    const result = await client.query<ErasureRequestRow>(
      `UPDATE operations.erasure_requests
       SET status='pending', next_attempt_at=now(), updated_at=now(),
           attempts=LEAST(attempts, max_attempts-1), locked_by=NULL, locked_at=NULL, lease_expires_at=NULL
       WHERE id=$1
       RETURNING id,merchant_id,customer_id,status,attempts,last_error,created_at,updated_at,completed_at`,
      [requestId],
    );
    return result.rows[0]!;
  }

  async recoverExpiredLeases(): Promise<number> {
    const result = await pool.query(
      `UPDATE operations.erasure_requests
       SET status='failed', next_attempt_at=now(), locked_by=NULL, locked_at=NULL, lease_expires_at=NULL,
           last_error=COALESCE(last_error,'worker_lease_expired'), updated_at=now()
       WHERE status='processing' AND lease_expires_at<now()`,
    );
    return result.rowCount ?? 0;
  }

  async claim(workerId: string, leaseSeconds = 120): Promise<ClaimedErasureRequest | undefined> {
    const result = await pool.query<ClaimedErasureRequest>(
      `UPDATE operations.erasure_requests
       SET status='processing', attempts=attempts+1, locked_by=$1, locked_at=now(),
           lease_expires_at=now()+($2 || ' seconds')::interval, last_error=NULL, updated_at=now()
       WHERE id=(SELECT id FROM operations.erasure_requests
         WHERE status IN ('pending','failed') AND next_attempt_at<=now() AND attempts<max_attempts
         ORDER BY next_attempt_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1)
       RETURNING id,merchant_id,customer_id,status,attempts,max_attempts,last_error,created_at,updated_at,completed_at`,
      [workerId, leaseSeconds],
    );
    return result.rows[0];
  }

  async complete(client: pg.PoolClient, requestId: string): Promise<void> {
    await client.query(
      `UPDATE operations.erasure_requests
       SET status='completed', completed_at=now(), updated_at=now(), last_error=NULL,
           subject_emails='{}', locked_by=NULL, locked_at=NULL, lease_expires_at=NULL
       WHERE id=$1`,
      [requestId],
    );
  }

  async fail(request: ClaimedErasureRequest, errorCode: string): Promise<void> {
    const retryable = request.attempts < request.max_attempts;
    await pool.query(
      `UPDATE operations.erasure_requests
       SET status='failed', last_error=$2, updated_at=now(),
           next_attempt_at=now()+($3 || ' seconds')::interval,
           locked_by=NULL, locked_at=NULL, lease_expires_at=NULL
       WHERE id=$1`,
      [request.id, errorCode, retryable ? Math.min(300, 2 ** request.attempts) : 0],
    );
  }

  async collectSubjectEmails(client: pg.PoolClient, merchantId: string, customerId: string): Promise<string[]> {
    const result = await client.query<{ email: string }>(
      `SELECT DISTINCT email FROM (
         SELECT email FROM customers.customers WHERE merchant_id=$1 AND id=$2
         UNION ALL
         SELECT value FROM customers.contacts WHERE merchant_id=$1 AND customer_id=$2 AND kind='email'
         UNION ALL
         SELECT customer_email FROM payments.refunds r
           JOIN payments.payment_intents p ON p.id=r.payment_intent_id
           WHERE p.merchant_id=$1 AND p.customer_id=$2 AND r.customer_email IS NOT NULL
         UNION ALL
         SELECT destination FROM operations.email_deliveries
           WHERE merchant_id=$1 AND customer_id=$2
         UNION ALL
         SELECT destination FROM operations.notifications
           WHERE merchant_id=$1 AND customer_id=$2
         UNION ALL
         SELECT destination FROM operations.notification_preferences
           WHERE merchant_id=$1 AND customer_id=$2
         UNION ALL
         SELECT email FROM provider_sandbox.customers
           WHERE merchant_id=$1 AND payflow_customer_id=$2
         UNION ALL
         SELECT customer_snapshot->>'email' FROM payments.payment_intents
           WHERE merchant_id=$1 AND customer_id=$2
         UNION ALL
         SELECT billing_snapshot->>'email' FROM payments.invoices
           WHERE merchant_id=$1 AND customer_id=$2
       ) emails WHERE email IS NOT NULL AND email <> ''`,
      [merchantId, customerId],
    );
    return result.rows.map((row) => row.email);
  }

  async rememberSubjectEmails(
    client: pg.PoolClient,
    merchantId: string,
    customerId: string,
    requestId: string,
  ): Promise<string[]> {
    const collected = await this.collectSubjectEmails(client, merchantId, customerId);
    const stored = await client.query<{ subject_emails: string[] }>(
      `SELECT subject_emails FROM operations.erasure_requests WHERE id=$1 FOR UPDATE`,
      [requestId],
    );
    const emails = [...new Set([...(stored.rows[0]?.subject_emails ?? []), ...collected])]
      .filter((email) => email.includes('@') && email !== 'erased' && !email.endsWith('@erased.invalid'));
    await client.query(
      `UPDATE operations.erasure_requests SET subject_emails=$2, updated_at=now() WHERE id=$1`,
      [requestId, emails],
    );
    return emails;
  }

  async redactCustomerRecord(client: pg.PoolClient, merchantId: string, customerId: string): Promise<void> {
    await client.query(
      `UPDATE customers.customers
       SET email=$3, name='Erased Customer', phone=NULL, metadata='{}'::jsonb,
           external_reference=$4, status='erased', version=version+1, updated_at=now()
       WHERE merchant_id=$1 AND id=$2`,
      [merchantId, customerId, erasedEmail(customerId), erasedExternalReference(customerId)],
    );
    await client.query(`DELETE FROM customers.addresses WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
    await client.query(`DELETE FROM customers.contacts WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
    await client.query(
      `UPDATE customers.payment_method_refs
       SET provider_token='erased', brand=NULL, last4=NULL, billing_name=NULL,
           billing_address=NULL, status='erased'
       WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId],
    );
    await client.query(
      `DELETE FROM customers.provider_customer_mappings WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId],
    );
  }

  async redactSupport(client: pg.PoolClient, merchantId: string, customerId: string): Promise<void> {
    const tickets = await client.query<{ ticket_id: string }>(
      `SELECT ticket_id FROM customers.support_participants WHERE customer_id=$1`,
      [customerId],
    );
    const ticketIds = tickets.rows.map((row) => row.ticket_id);
    if (ticketIds.length === 0) return;

    await client.query(
      `UPDATE customers.support_messages
       SET body='[redacted]', author_id=NULL, attachments='[]'::jsonb
       WHERE merchant_id=$1 AND author_id=$2`,
      [merchantId, customerId],
    );
    await client.query(`DELETE FROM customers.support_participants WHERE customer_id=$1 AND ticket_id=ANY($2::uuid[])`, [customerId, ticketIds]);

    const orphaned = await client.query<{ id: string }>(
      `SELECT t.id FROM customers.support_tickets t
       WHERE t.id=ANY($1::uuid[])
         AND NOT EXISTS (SELECT 1 FROM customers.support_participants p WHERE p.ticket_id=t.id)`,
      [ticketIds],
    );
    const orphanedIds = orphaned.rows.map((row) => row.id);
    if (orphanedIds.length === 0) return;
    await client.query(`DELETE FROM customers.support_messages WHERE ticket_id=ANY($1::uuid[])`, [orphanedIds]);
    await client.query(`DELETE FROM customers.support_tickets WHERE id=ANY($1::uuid[])`, [orphanedIds]);
  }

  async redactFinancialRecords(client: pg.PoolClient, merchantId: string, customerId: string): Promise<void> {
    await client.query(
      `UPDATE payments.payment_intents
       SET customer_snapshot=jsonb_build_object('id', customer_id, 'status', 'erased'),
           description=NULL, updated_at=now()
       WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId],
    );
    await client.query(
      `UPDATE payments.refunds r SET customer_email=NULL
       FROM payments.payment_intents p
       WHERE r.payment_intent_id=p.id AND p.merchant_id=$1 AND p.customer_id=$2`,
      [merchantId, customerId],
    );
    await client.query(
      `UPDATE payments.invoices
       SET billing_snapshot=jsonb_build_object('id', customer_id, 'status', 'erased')
       WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId],
    );
    await client.query(
      `UPDATE payments.payment_attempts a
       SET request_payload=COALESCE(a.request_payload, '{}'::jsonb) - 'email' - 'name' - 'customerEmail' - 'description',
           response_payload=CASE WHEN a.response_payload IS NULL THEN NULL
             ELSE a.response_payload - 'email' - 'name' - 'customerEmail' - 'description' END
       FROM payments.payment_intents p
       WHERE a.payment_intent_id=p.id AND p.merchant_id=$1 AND p.customer_id=$2`,
      [merchantId, customerId],
    );
    await client.query(
      `UPDATE payments.disputes d
       SET evidence='{}'::jsonb
       FROM payments.payment_intents p
       WHERE d.payment_intent_id=p.id AND p.merchant_id=$1 AND p.customer_id=$2`,
      [merchantId, customerId],
    );
  }

  async redactOperationalRecords(client: pg.PoolClient, merchantId: string, customerId: string): Promise<void> {
    await client.query(
      `UPDATE platform.audit_logs SET metadata='{}'::jsonb
       WHERE merchant_id=$1 AND target_type='customer' AND target_id=$2`,
      [merchantId, customerId],
    );
    await client.query(`DELETE FROM operations.analytics_events WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
    await client.query(`DELETE FROM operations.notification_preferences WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
    await client.query(
      `UPDATE operations.notifications
       SET destination='erased', payload=jsonb_build_object('erased', true), last_error=NULL, updated_at=now()
       WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId],
    );
    await client.query(
      `UPDATE operations.email_deliveries
       SET destination='erased', subject='erased', text_body='erased', html_body='erased',
           status=CASE WHEN status IN ('pending','processing','failed') THEN 'cancelled' ELSE status END,
           cancelled_at=CASE WHEN status IN ('pending','processing','failed') THEN now() ELSE cancelled_at END,
           last_error=NULL
       WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId],
    );
    await client.query(
      `UPDATE operations.outbox_events
       SET payload=(payload - 'email' - 'name' - 'phone' - 'customerEmail' - 'body' - 'subject' - 'customer')
         || jsonb_build_object('erased', true)
       WHERE merchant_id=$1 AND (aggregate_id=$2 OR payload->>'customerId'=$2)`,
      [merchantId, customerId],
    );
    await client.query(
      `UPDATE operations.jobs
       SET payload=(payload - 'customerSnapshot' - 'email' - 'customerEmail')
         || jsonb_build_object('customerSnapshot', jsonb_build_object('id', $2::text, 'status', 'erased'), 'erased', true)
       WHERE merchant_id=$1 AND payload->>'customerId'=$2`,
      [merchantId, customerId],
    );
    await client.query(
      `UPDATE operations.dead_letters
       SET payload=(payload - 'email' - 'name' - 'phone' - 'customerEmail' - 'destination' - 'body')
         || jsonb_build_object('erased', true)
       WHERE payload->>'customerId'=$2 OR payload->>'customer_id'=$2`,
      [customerId],
    );
    await client.query(
      `UPDATE operations.document_manifests
       SET metadata=(COALESCE(metadata, '{}'::jsonb) - 'email' - 'name' - 'customerEmail')
         || jsonb_build_object('erased', true)
       WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId],
    );
    await client.query(
      `UPDATE provider_sandbox.customers
       SET email=$3, name='Erased Customer', external_reference=$4, updated_at=now()
       WHERE merchant_id=$1 AND payflow_customer_id=$2`,
      [merchantId, customerId, erasedEmail(customerId), erasedExternalReference(customerId)],
    );
  }

  async listDocumentKeys(client: pg.PoolClient, merchantId: string, customerId: string): Promise<Array<{ objectKey: string; documentType: string }>> {
    const result = await client.query<{ object_key: string; document_type: string }>(
      `SELECT object_key, document_type FROM operations.document_manifests
       WHERE merchant_id=$1 AND customer_id=$2
       UNION
       SELECT object_key, 'invoice' FROM payments.invoices WHERE merchant_id=$1 AND customer_id=$2 AND object_key IS NOT NULL
       UNION
       SELECT object_key, 'customer_import' FROM customers.customer_imports
        WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId],
    );
    return result.rows.map((row) => ({ objectKey: row.object_key, documentType: row.document_type }));
  }

  async listImportArtifacts(client: pg.PoolClient, merchantId: string): Promise<Array<{ id: string; objectKey: string }>> {
    const result = await client.query<{ id: string; object_key: string }>(
      `SELECT id, object_key FROM customers.customer_imports WHERE merchant_id=$1`,
      [merchantId],
    );
    return result.rows.map((row) => ({ id: row.id, objectKey: row.object_key }));
  }

  async deleteImport(client: pg.PoolClient, merchantId: string, importId: string, objectKey: string): Promise<void> {
    await client.query(`DELETE FROM operations.document_manifests WHERE merchant_id=$1 AND object_key=$2`, [merchantId, objectKey]);
    await client.query(`DELETE FROM customers.customer_imports WHERE merchant_id=$1 AND id=$2`, [merchantId, importId]);
  }
}
