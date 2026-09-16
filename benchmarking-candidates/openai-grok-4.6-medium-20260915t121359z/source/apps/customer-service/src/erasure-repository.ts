import type { PoolClient } from 'pg';
import { pool } from '../../../packages/database/src/pool.js';
import { boundedExponentialBackoffSeconds } from '../../../packages/operations/src/retry-policy.js';
import {
  anonymizedCustomerRecord,
  anonymizedCustomerSnapshot,
  erasedEmail,
  redactJson,
} from '../../../packages/privacy/src/redaction.js';
import { ensureErasureTombstone } from '../../../packages/privacy/src/tombstones.js';
import type { ErasureRequestRow } from './erasure-types.js';

export type { ErasureRequestRow, PublicErasureRequest } from './erasure-types.js';
export { toPublicErasureRequest } from './erasure-types.js';

export class ErasureRepository {
  async findCustomer(client: PoolClient, merchantId: string, customerId: string): Promise<{ id: string; status: string } | undefined> {
    const result = await client.query<{ id: string; status: string }>(
      `SELECT id,status FROM customers.customers WHERE merchant_id=$1 AND id=$2 FOR UPDATE`,
      [merchantId, customerId],
    );
    return result.rows[0];
  }

  async findByCustomer(client: PoolClient, merchantId: string, customerId: string): Promise<ErasureRequestRow | undefined> {
    const result = await client.query<ErasureRequestRow>(
      `SELECT id,merchant_id,customer_id,status,attempts,last_error,created_at,updated_at,completed_at
       FROM customers.erasure_requests WHERE merchant_id=$1 AND customer_id=$2 FOR UPDATE`,
      [merchantId, customerId],
    );
    return result.rows[0];
  }

  async findById(merchantId: string, requestId: string): Promise<ErasureRequestRow | undefined> {
    const result = await pool.query<ErasureRequestRow>(
      `SELECT id,merchant_id,customer_id,status,attempts,last_error,created_at,updated_at,completed_at
       FROM customers.erasure_requests WHERE merchant_id=$1 AND id=$2`,
      [merchantId, requestId],
    );
    return result.rows[0];
  }

  async create(
    client: PoolClient,
    merchantId: string,
    customerId: string,
  ): Promise<ErasureRequestRow> {
    const result = await client.query<ErasureRequestRow>(
      `INSERT INTO customers.erasure_requests(merchant_id,customer_id,status)
       VALUES($1,$2,'pending') RETURNING id,merchant_id,customer_id,status,attempts,last_error,created_at,updated_at,completed_at`,
      [merchantId, customerId],
    );
    const row = result.rows[0]!;
    await ensureErasureTombstone(client, merchantId, customerId, row.id);
    await client.query(
      `UPDATE customers.customers SET status='erased',updated_at=now() WHERE merchant_id=$1 AND id=$2`,
      [merchantId, customerId],
    );
    await client.query(
      `INSERT INTO platform.audit_logs(merchant_id,actor_type,target_type,target_id,action,metadata,correlation_id)
       VALUES($1,'api_key','customer',$2,'customer.erasure.requested',$3,$4)`,
      [merchantId, customerId, { requestId: row.id }, row.id],
    );
    return row;
  }

  async requeue(client: PoolClient, request: ErasureRequestRow): Promise<ErasureRequestRow> {
    if (request.status === 'completed' || request.status === 'pending' || request.status === 'processing') {
      return request;
    }
    const result = await client.query<ErasureRequestRow>(
      `UPDATE customers.erasure_requests
       SET status='pending',available_at=now(),updated_at=now(),last_error=NULL,
           locked_by=NULL,locked_at=NULL,lease_expires_at=NULL
       WHERE id=$1
       RETURNING id,merchant_id,customer_id,status,attempts,last_error,created_at,updated_at,completed_at`,
      [request.id],
    );
    return result.rows[0] ?? request;
  }

  async recoverExpiredLeases(): Promise<number> {
    const result = await pool.query(
      `UPDATE customers.erasure_requests
       SET status='failed',available_at=now(),locked_by=NULL,locked_at=NULL,lease_expires_at=NULL,
           last_error=COALESCE(last_error,'worker_lease_expired'),updated_at=now()
       WHERE status='processing' AND lease_expires_at<now()`,
    );
    return result.rowCount ?? 0;
  }

  async claim(workerId: string, leaseSeconds = 60): Promise<ErasureRequestRow | undefined> {
    const result = await pool.query<ErasureRequestRow>(
      `UPDATE customers.erasure_requests
       SET status='processing',attempts=attempts+1,locked_by=$1,locked_at=now(),
           lease_expires_at=now()+($2 || ' seconds')::interval,last_error=NULL,updated_at=now()
       WHERE id=(SELECT id FROM customers.erasure_requests
         WHERE status IN ('pending','failed') AND available_at<=now()
         ORDER BY available_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1)
       RETURNING id,merchant_id,customer_id,status,attempts,last_error,created_at,updated_at,completed_at`,
      [workerId, leaseSeconds],
    );
    return result.rows[0];
  }

  async complete(client: PoolClient, requestId: string): Promise<void> {
    await client.query(
      `UPDATE customers.erasure_requests
       SET status='completed',completed_at=COALESCE(completed_at,now()),updated_at=now(),
           locked_by=NULL,locked_at=NULL,lease_expires_at=NULL,last_error=NULL
       WHERE id=$1`,
      [requestId],
    );
  }

  async fail(request: ErasureRequestRow, errorCode: string): Promise<void> {
    await pool.query(
      `UPDATE customers.erasure_requests
       SET status='failed',available_at=now()+($2 || ' seconds')::interval,last_error=$3,
           locked_by=NULL,locked_at=NULL,lease_expires_at=NULL,updated_at=now()
       WHERE id=$1`,
      [request.id, boundedExponentialBackoffSeconds(request.attempts), errorCode],
    );
  }

  async collectDestinations(merchantId: string, customerId: string): Promise<string[]> {
    const result = await pool.query<{ destination: string }>(
      `SELECT DISTINCT destination FROM (
         SELECT email AS destination FROM customers.customers WHERE merchant_id=$1 AND id=$2
         UNION ALL
         SELECT value FROM customers.contacts WHERE merchant_id=$1 AND customer_id=$2 AND kind='email'
         UNION ALL
         SELECT destination FROM operations.notification_preferences WHERE merchant_id=$1 AND customer_id=$2
         UNION ALL
         SELECT destination FROM operations.email_deliveries WHERE merchant_id=$1 AND customer_id=$2
         UNION ALL
         SELECT destination FROM operations.notifications WHERE merchant_id=$1 AND customer_id=$2
         UNION ALL
         SELECT customer_email FROM payments.refunds WHERE merchant_id=$1 AND customer_email IS NOT NULL
           AND payment_intent_id IN (SELECT id FROM payments.payment_intents WHERE merchant_id=$1 AND customer_id=$2)
         UNION ALL
         SELECT customer_snapshot->>'email' FROM payments.payment_intents WHERE merchant_id=$1 AND customer_id=$2
         UNION ALL
         SELECT billing_snapshot->>'email' FROM payments.invoices WHERE merchant_id=$1 AND customer_id=$2
       ) addresses
       WHERE destination IS NOT NULL AND destination <> '' AND destination NOT LIKE '%@erased.invalid'`,
      [merchantId, customerId],
    );
    return result.rows.map((row) => row.destination);
  }

  async listCustomerDocuments(merchantId: string, customerId: string): Promise<Array<{ object_key: string; document_type: string }>> {
    const result = await pool.query<{ object_key: string; document_type: string }>(
      `SELECT object_key,document_type FROM operations.document_manifests
       WHERE merchant_id=$1 AND (customer_id=$2 OR document_type='customer_import')`,
      [merchantId, customerId],
    );
    return result.rows;
  }

  async redactDatabase(client: PoolClient, merchantId: string, customerId: string, requestId: string): Promise<void> {
    await ensureErasureTombstone(client, merchantId, customerId, requestId);
    const identity = anonymizedCustomerRecord(customerId);
    const snapshot = anonymizedCustomerSnapshot(customerId);

    await client.query(
      `UPDATE customers.customers
       SET email=$3,name=$4,phone=$5,external_reference=$6,metadata=$7,status='erased',
           version=version+1,updated_at=now()
       WHERE merchant_id=$1 AND id=$2`,
      [merchantId, customerId, identity.email, identity.name, identity.phone, identity.external_reference, identity.metadata],
    );
    await client.query(`DELETE FROM customers.addresses WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
    await client.query(`DELETE FROM customers.contacts WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
    await client.query(
      `UPDATE customers.payment_method_refs
       SET provider_token='erased',brand=NULL,last4=NULL,billing_name=NULL,billing_address=NULL,status='revoked'
       WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId],
    );
    await client.query(`DELETE FROM customers.provider_customer_mappings WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);

    const tickets = await client.query<{ ticket_id: string }>(
      `SELECT ticket_id FROM customers.support_participants WHERE customer_id=$1`,
      [customerId],
    );
    await client.query(
      `UPDATE customers.support_messages SET body='',author_id=NULL
       WHERE merchant_id=$1 AND author_type='customer' AND author_id=$2`,
      [merchantId, customerId],
    );
    await client.query(`DELETE FROM customers.support_participants WHERE customer_id=$1`, [customerId]);
    if (tickets.rowCount) {
      await client.query(
        `UPDATE customers.support_tickets SET subject='ERASED'
         WHERE merchant_id=$1 AND id=ANY($2::uuid[])
           AND NOT EXISTS (SELECT 1 FROM customers.support_participants p WHERE p.ticket_id=customers.support_tickets.id)`,
        [merchantId, tickets.rows.map((row) => row.ticket_id)],
      );
    }

    await client.query(
      `UPDATE payments.payment_intents
       SET customer_snapshot=$3,description=NULL,updated_at=now()
       WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId, snapshot],
    );
    await client.query(
      `UPDATE payments.refunds SET customer_email=$3
       WHERE merchant_id=$1 AND payment_intent_id IN (
         SELECT id FROM payments.payment_intents WHERE merchant_id=$1 AND customer_id=$2
       )`,
      [merchantId, customerId, erasedEmail(customerId)],
    );
    await client.query(
      `UPDATE payments.invoices SET billing_snapshot=$3
       WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId, snapshot],
    );
    const attempts = await client.query<{ id: string; request_payload: unknown; response_payload: unknown }>(
      `SELECT id,request_payload,response_payload FROM payments.payment_attempts
       WHERE merchant_id=$1 AND payment_intent_id IN (
         SELECT id FROM payments.payment_intents WHERE merchant_id=$1 AND customer_id=$2
       )`,
      [merchantId, customerId],
    );
    for (const attempt of attempts.rows) {
      await client.query(
        `UPDATE payments.payment_attempts SET request_payload=$2,response_payload=$3 WHERE id=$1`,
        [attempt.id, redactJson(attempt.request_payload, customerId), attempt.response_payload === null ? null : redactJson(attempt.response_payload, customerId)],
      );
    }

    const analytics = await client.query<{ id: string; properties: unknown }>(
      `SELECT id,properties FROM operations.analytics_events WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId],
    );
    for (const event of analytics.rows) {
      await client.query(
        `UPDATE operations.analytics_events SET email=$2,properties=$3,anonymous_id='anon_erased' WHERE id=$1`,
        [event.id, erasedEmail(customerId), redactJson(event.properties, customerId)],
      );
    }
    await client.query(
      `DELETE FROM operations.notification_preferences WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId],
    );
    await client.query(
      `UPDATE operations.email_deliveries
       SET destination=$3,subject='ERASED',text_body='',html_body='',
           status=CASE WHEN status IN ('pending','failed','processing') THEN 'cancelled' ELSE status END,
           cancelled_at=CASE WHEN status IN ('pending','failed','processing') THEN now() ELSE cancelled_at END,
           locked_by=NULL,locked_at=NULL,lease_expires_at=NULL
       WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId, erasedEmail(customerId)],
    );
    const notifications = await client.query<{ id: string; payload: unknown }>(
      `SELECT id,payload FROM operations.notifications WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId],
    );
    for (const notification of notifications.rows) {
      await client.query(
        `UPDATE operations.notifications
         SET destination=$3,payload=$4,
             status=CASE WHEN status IN ('queued','retrying','pending') THEN 'cancelled' ELSE status END,
             updated_at=now()
         WHERE id=$1`,
        [notification.id, customerId, erasedEmail(customerId), redactJson(notification.payload, customerId)],
      );
    }
    const manifests = await client.query<{ id: string; metadata: unknown }>(
      `SELECT id,metadata FROM operations.document_manifests WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId],
    );
    for (const manifest of manifests.rows) {
      await client.query(
        `UPDATE operations.document_manifests SET metadata=$2 WHERE id=$1`,
        [manifest.id, redactJson(manifest.metadata, customerId)],
      );
    }
    const events = await client.query<{ id: string; payload: unknown }>(
      `SELECT id,payload FROM operations.outbox_events
       WHERE merchant_id=$1 AND (aggregate_id=$2 OR payload->>'customerId'=$2)`,
      [merchantId, customerId],
    );
    for (const event of events.rows) {
      await client.query(`UPDATE operations.outbox_events SET payload=$2 WHERE id=$1`, [
        event.id, redactJson(event.payload, customerId),
      ]);
    }
    const jobs = await client.query<{ id: string; payload: unknown }>(
      `SELECT id,payload FROM operations.jobs WHERE merchant_id=$1 AND payload->>'customerId'=$2`,
      [merchantId, customerId],
    );
    for (const job of jobs.rows) {
      await client.query(`UPDATE operations.jobs SET payload=$2 WHERE id=$1`, [
        job.id, redactJson(job.payload, customerId),
      ]);
    }
    const letters = await client.query<{ id: string; payload: unknown }>(
      `SELECT id,payload FROM operations.dead_letters
       WHERE payload->>'customerId'=$1 OR payload->>'customer_id'=$1`,
      [customerId],
    );
    for (const letter of letters.rows) {
      await client.query(`UPDATE operations.dead_letters SET payload=$2 WHERE id=$1`, [
        letter.id, redactJson(letter.payload, customerId),
      ]);
    }
    const audits = await client.query<{ id: string; metadata: unknown }>(
      `SELECT id,metadata FROM platform.audit_logs WHERE merchant_id=$1 AND target_id=$2`,
      [merchantId, customerId],
    );
    for (const audit of audits.rows) {
      await client.query(`UPDATE platform.audit_logs SET metadata=$2 WHERE id=$1`, [
        audit.id, redactJson(audit.metadata, customerId),
      ]);
    }
    await client.query(
      `UPDATE provider_sandbox.customers
       SET email=$3,name='ERASED',external_reference=$4,updated_at=now()
       WHERE merchant_id=$1 AND payflow_customer_id=$2`,
      [merchantId, customerId, erasedEmail(customerId), `erased:${customerId}`],
    );
    await client.query(
      `UPDATE customers.customer_imports SET source='erased'
       WHERE merchant_id=$1 AND object_key IN (
         SELECT object_key FROM operations.document_manifests
         WHERE merchant_id=$1 AND document_type='customer_import'
       )`,
      [merchantId],
    );
  }
}
