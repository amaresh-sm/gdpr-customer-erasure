import type pg from 'pg';
import { pool, transaction } from '../../../packages/database/src/pool.js';
import {
  erasedEmail,
  erasedReference,
  REDACTED,
  redactJson,
  redactJsonValues,
  redactText,
} from '../../../packages/privacy/src/redact.js';
import type { CollectedCustomerPii, ErasureRequestRow } from './erasure-types.js';
import { piiValuesFrom } from './erasure-types.js';

export class ErasureRepository {
  async findByCustomer(merchantId: string, customerId: string): Promise<ErasureRequestRow | undefined> {
    const result = await pool.query<ErasureRequestRow>(
      `SELECT id,merchant_id,customer_id,status,attempts,last_error,created_at,updated_at,completed_at
       FROM customers.erasure_requests WHERE merchant_id=$1 AND customer_id=$2`,
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

  async create(client: pg.PoolClient, merchantId: string, customerId: string): Promise<ErasureRequestRow> {
    const result = await client.query<ErasureRequestRow>(
      `INSERT INTO customers.erasure_requests(merchant_id,customer_id,status)
       VALUES($1,$2,'pending')
       ON CONFLICT(merchant_id,customer_id) DO UPDATE SET updated_at=customers.erasure_requests.updated_at
       RETURNING id,merchant_id,customer_id,status,attempts,last_error,created_at,updated_at,completed_at`,
      [merchantId, customerId],
    );
    return result.rows[0]!;
  }

  async requeue(client: pg.PoolClient, requestId: string): Promise<ErasureRequestRow> {
    const result = await client.query<ErasureRequestRow>(
      `UPDATE customers.erasure_requests
       SET status='pending', available_at=now(), last_error=NULL, updated_at=now()
       WHERE id=$1 AND status='failed'
       RETURNING id,merchant_id,customer_id,status,attempts,last_error,created_at,updated_at,completed_at`,
      [requestId],
    );
    if (result.rows[0]) return result.rows[0];
    const existing = await client.query<ErasureRequestRow>(
      `SELECT id,merchant_id,customer_id,status,attempts,last_error,created_at,updated_at,completed_at
       FROM customers.erasure_requests WHERE id=$1`,
      [requestId],
    );
    return existing.rows[0]!;
  }

  async claim(): Promise<ErasureRequestRow | undefined> {
    return transaction(async (client) => {
      const result = await client.query<ErasureRequestRow>(
        `UPDATE customers.erasure_requests
         SET status='processing', attempts=attempts+1, lease_expires_at=now()+interval '120 seconds',
             last_error=NULL, updated_at=now()
         WHERE id=(SELECT id FROM customers.erasure_requests
           WHERE status IN ('pending','failed') AND available_at<=now()
           ORDER BY available_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1)
         RETURNING id,merchant_id,customer_id,status,attempts,last_error,created_at,updated_at,completed_at`,
      );
      return result.rows[0];
    });
  }

  async recoverExpiredLeases(): Promise<number> {
    const result = await pool.query(
      `UPDATE customers.erasure_requests
       SET status='failed', available_at=now(), lease_expires_at=NULL,
           last_error=COALESCE(last_error,'worker_lease_expired'), updated_at=now()
       WHERE status='processing' AND lease_expires_at<now()`,
    );
    return result.rowCount ?? 0;
  }

  async markFailed(requestId: string, errorCode: string): Promise<void> {
    await pool.query(
      `UPDATE customers.erasure_requests
       SET status='failed', last_error=$2, available_at=now()+interval '5 seconds',
           lease_expires_at=NULL, updated_at=now()
       WHERE id=$1 AND status='processing'`,
      [requestId, errorCode],
    );
  }

  async markCompleted(client: pg.PoolClient, requestId: string): Promise<ErasureRequestRow> {
    const result = await client.query<ErasureRequestRow>(
      `UPDATE customers.erasure_requests
       SET status='completed', last_error=NULL, completed_at=COALESCE(completed_at,now()),
           lease_expires_at=NULL, updated_at=now()
       WHERE id=$1
       RETURNING id,merchant_id,customer_id,status,attempts,last_error,created_at,updated_at,completed_at`,
      [requestId],
    );
    return result.rows[0]!;
  }

  async customerExists(merchantId: string, customerId: string): Promise<boolean> {
    const result = await pool.query(
      `SELECT 1 FROM customers.customers WHERE merchant_id=$1 AND id=$2`,
      [merchantId, customerId],
    );
    return Boolean(result.rowCount);
  }

  async collect(merchantId: string, customerId: string): Promise<CollectedCustomerPii> {
    const customer = await pool.query<{
      email: string; name: string; phone: string | null; external_reference: string;
    }>(
      `SELECT email,name,phone,external_reference FROM customers.customers
       WHERE merchant_id=$1 AND id=$2`,
      [merchantId, customerId],
    );
    const row = customer.rows[0];
    const contacts = await pool.query<{ value: string }>(
      `SELECT value FROM customers.contacts WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId],
    );
    const addresses = await pool.query<{ line1: string; line2: string | null; city: string }>(
      `SELECT line1,line2,city FROM customers.addresses WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId],
    );
    const methods = await pool.query<{ billing_name: string | null; provider_token: string }>(
      `SELECT billing_name,provider_token FROM customers.payment_method_refs
       WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId],
    );
    const documents = await pool.query<{ object_key: string }>(
      `SELECT object_key FROM operations.document_manifests
       WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId],
    );
    const snapshots = await pool.query<{ email: string | null; name: string | null; phone: string | null }>(
      `SELECT customer_snapshot->>'email' AS email, customer_snapshot->>'name' AS name,
              customer_snapshot->>'phone' AS phone
       FROM payments.payment_intents WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId],
    );
    const refunds = await pool.query<{ customer_email: string | null }>(
      `SELECT customer_email FROM payments.refunds
       WHERE merchant_id=$1 AND payment_intent_id IN (
         SELECT id FROM payments.payment_intents WHERE merchant_id=$1 AND customer_id=$2
       )`,
      [merchantId, customerId],
    );
    const destinations = await pool.query<{ destination: string }>(
      `SELECT destination FROM operations.email_deliveries WHERE merchant_id=$1 AND customer_id=$2
       UNION
       SELECT destination FROM operations.notifications WHERE merchant_id=$1 AND customer_id=$2
       UNION
       SELECT destination FROM operations.notification_preferences WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId],
    );
    const emails = [
      row?.email,
      ...snapshots.rows.map((item) => item.email),
      ...refunds.rows.map((item) => item.customer_email),
      ...destinations.rows.map((item) => item.destination),
    ].filter((value): value is string => typeof value === 'string' && !value.endsWith('@erased.invalid'));
    return {
      customerId,
      merchantId,
      emails: [...new Set(emails)],
      names: [...new Set([row?.name, ...snapshots.rows.map((item) => item.name)].filter((value): value is string => Boolean(value) && value !== REDACTED))],
      phones: [...new Set([row?.phone, ...snapshots.rows.map((item) => item.phone)].filter((value): value is string => Boolean(value)))],
      contacts: contacts.rows.map((item) => item.value).filter((value) => value !== REDACTED),
      addresses: addresses.rows.flatMap((item) => [item.line1, item.line2].filter((value): value is string => Boolean(value) && value !== REDACTED)),
      billingNames: methods.rows.map((item) => item.billing_name).filter((value): value is string => Boolean(value) && value !== REDACTED),
      tokens: methods.rows.map((item) => item.provider_token).filter((value) => !value.startsWith('erased-')),
      references: row && !row.external_reference.startsWith('erased-') ? [row.external_reference] : [],
      documentKeys: [...new Set(documents.rows.map((item) => item.object_key))],
    };
  }

  async redactDatabase(
    client: pg.PoolClient, merchantId: string, customerId: string, collected: CollectedCustomerPii,
  ): Promise<void> {
    const pii = piiValuesFrom(collected);
    await client.query(
      `UPDATE customers.customers
       SET email=$3, name=$4, phone=NULL, external_reference=$5, metadata='{}'::jsonb,
           status='erased', version=version+1, updated_at=now()
       WHERE merchant_id=$1 AND id=$2`,
      [merchantId, customerId, erasedEmail(customerId), REDACTED, erasedReference(customerId)],
    );
    await client.query(
      `UPDATE customers.addresses
       SET line1=$3, line2=NULL, city=$3, region=NULL, postal_code='00000'
       WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId, REDACTED],
    );
    await client.query(
      `UPDATE customers.contacts SET value=$3 WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId, REDACTED],
    );
    await client.query(
      `UPDATE customers.payment_method_refs
       SET provider_token=$3, billing_name=$4, billing_address=NULL, last4=NULL, status='erased'
       WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId, `erased-${customerId}`, REDACTED],
    );

    const intents = await client.query<{ id: string; customer_snapshot: unknown; description: string | null }>(
      `SELECT id,customer_snapshot,description FROM payments.payment_intents
       WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId],
    );
    for (const row of intents.rows) {
      await client.query(
        `UPDATE payments.payment_intents SET customer_snapshot=$2, description=$3, updated_at=now() WHERE id=$1`,
        [row.id, redactJson(row.customer_snapshot, pii), redactText(row.description, pii)],
      );
    }

    const attempts = await client.query<{ id: string; request_payload: unknown; response_payload: unknown }>(
      `SELECT a.id,a.request_payload,a.response_payload FROM payments.payment_attempts a
       JOIN payments.payment_intents p ON p.id=a.payment_intent_id
       WHERE p.merchant_id=$1 AND p.customer_id=$2`,
      [merchantId, customerId],
    );
    for (const row of attempts.rows) {
      await client.query(
        `UPDATE payments.payment_attempts SET request_payload=$2, response_payload=$3 WHERE id=$1`,
        [row.id, redactJson(row.request_payload, pii), redactJson(row.response_payload, pii)],
      );
    }

    await client.query(
      `UPDATE payments.refunds SET customer_email=$3
       WHERE merchant_id=$1 AND payment_intent_id IN (
         SELECT id FROM payments.payment_intents WHERE merchant_id=$1 AND customer_id=$2)`,
      [merchantId, customerId, erasedEmail(customerId)],
    );

    const disputes = await client.query<{ id: string; evidence: unknown }>(
      `SELECT d.id,d.evidence FROM payments.disputes d
       JOIN payments.payment_intents p ON p.id=d.payment_intent_id
       WHERE p.merchant_id=$1 AND p.customer_id=$2`,
      [merchantId, customerId],
    );
    for (const row of disputes.rows) {
      await client.query(`UPDATE payments.disputes SET evidence=$2 WHERE id=$1`, [row.id, redactJson(row.evidence, pii)]);
    }

    const invoices = await client.query<{ id: string; billing_snapshot: unknown }>(
      `SELECT id,billing_snapshot FROM payments.invoices WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId],
    );
    for (const row of invoices.rows) {
      await client.query(
        `UPDATE payments.invoices SET billing_snapshot=$2 WHERE id=$1`,
        [row.id, redactJson(row.billing_snapshot, pii)],
      );
    }

    const entries = await client.query<{ id: string; description: string }>(
      `SELECT id,description FROM payments.ledger_entries
       WHERE merchant_id=$1 AND (
         reference_id IN (SELECT id FROM payments.payment_intents WHERE merchant_id=$1 AND customer_id=$2)
         OR reference_id IN (
           SELECT r.id FROM payments.refunds r
           JOIN payments.payment_intents p ON p.id=r.payment_intent_id
           WHERE p.merchant_id=$1 AND p.customer_id=$2
         )
       )`,
      [merchantId, customerId],
    );
    for (const row of entries.rows) {
      const next = redactText(row.description, pii);
      if (next !== row.description) {
        await client.query(`UPDATE payments.ledger_entries SET description=$2 WHERE id=$1`, [row.id, next]);
      }
    }

    const audits = await client.query<{ id: string; metadata: unknown }>(
      `SELECT id,metadata FROM platform.audit_logs
       WHERE merchant_id=$1 AND target_type='customer' AND target_id=$2::text`,
      [merchantId, customerId],
    );
    for (const row of audits.rows) {
      await client.query(`UPDATE platform.audit_logs SET metadata=$2 WHERE id=$1`, [row.id, redactJson(row.metadata, pii)]);
    }

    const events = await client.query<{ id: string; payload: unknown }>(
      `SELECT id,payload FROM operations.outbox_events
       WHERE merchant_id=$1 AND (
         aggregate_id=$2 OR payload->>'customerId'=$2::text OR payload->>'customer_id'=$2::text
       )`,
      [merchantId, customerId],
    );
    for (const row of events.rows) {
      await client.query(`UPDATE operations.outbox_events SET payload=$2 WHERE id=$1`, [row.id, redactJson(row.payload, pii)]);
    }

    const analytics = await client.query<{ id: string; properties: unknown }>(
      `SELECT id,properties FROM operations.analytics_events WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId],
    );
    for (const row of analytics.rows) {
      await client.query(
        `UPDATE operations.analytics_events SET email=$2, properties=$3, anonymous_id=$4 WHERE id=$1`,
        [row.id, erasedEmail(customerId), redactJson(row.properties, pii), `anon_${customerId}`],
      );
    }

    const jobs = await client.query<{ id: string; payload: unknown }>(
      `SELECT id,payload FROM operations.jobs
       WHERE merchant_id=$1 AND (payload->>'customerId'=$2::text OR payload->>'customer_id'=$2::text)`,
      [merchantId, customerId],
    );
    for (const row of jobs.rows) {
      await client.query(`UPDATE operations.jobs SET payload=$2 WHERE id=$1`, [row.id, redactJson(row.payload, pii)]);
    }

    const webhooks = await client.query<{ id: string; payload: unknown }>(
      `SELECT w.id,w.payload FROM operations.provider_webhooks w
       WHERE w.payload->'data'->>'paymentId' IN (
         SELECT id::text FROM payments.payment_intents WHERE merchant_id=$1 AND customer_id=$2
       ) OR w.payload->'data'->>'customerId'=$2::text`,
      [merchantId, customerId],
    );
    for (const row of webhooks.rows) {
      await client.query(`UPDATE operations.provider_webhooks SET payload=$2 WHERE id=$1`, [row.id, redactJson(row.payload, pii)]);
    }

    const settlements = await client.query<{ id: string; raw_payload: unknown }>(
      `SELECT id,raw_payload FROM payments.provider_settlements WHERE merchant_id=$1`,
      [merchantId],
    );
    for (const row of settlements.rows) {
      await client.query(
        `UPDATE payments.provider_settlements SET raw_payload=$2 WHERE id=$1`,
        [row.id, redactJsonValues(row.raw_payload, pii)],
      );
    }

    const deadLetters = await client.query<{ id: string; payload: unknown }>(
      `SELECT id,payload FROM operations.dead_letters
       WHERE payload->>'customerId'=$1 OR payload->>'customer_id'=$1
          OR payload->'data'->>'customerId'=$1`,
      [customerId],
    );
    for (const row of deadLetters.rows) {
      await client.query(`UPDATE operations.dead_letters SET payload=$2 WHERE id=$1`, [row.id, redactJson(row.payload, pii)]);
    }

    await this.sweepRemaining(client, merchantId, customerId, pii);

    const sandboxCustomers = await client.query(
      `UPDATE provider_sandbox.customers
       SET email=$3, name=$4, external_reference=$5, updated_at=now()
       WHERE merchant_id=$1 AND payflow_customer_id=$2`,
      [merchantId, customerId, erasedEmail(customerId), REDACTED, erasedReference(customerId)],
    );
    void sandboxCustomers;

    await this.redactSupport(client, merchantId, customerId, pii);
    await client.query(
      `DELETE FROM operations.notifications WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId],
    );
    await client.query(
      `DELETE FROM operations.email_deliveries WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId],
    );
    await client.query(
      `DELETE FROM operations.notification_preferences WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId],
    );
  }

  async listFinancialDocumentKeys(
    merchantId: string, customerId: string,
  ): Promise<Array<{ object_key: string; document_type: string }>> {
    const result = await pool.query<{ object_key: string; document_type: string }>(
      `SELECT object_key,document_type FROM operations.document_manifests
       WHERE merchant_id=$1 AND customer_id=$2 AND document_type IN ('invoice','receipt')`,
      [merchantId, customerId],
    );
    return result.rows;
  }

  async listImportObjectKeys(merchantId: string): Promise<string[]> {
    const result = await pool.query<{ object_key: string }>(
      `SELECT object_key FROM customers.customer_imports WHERE merchant_id=$1`,
      [merchantId],
    );
    return result.rows.map((row) => row.object_key);
  }

  async deleteStoredDocument(objectKey: string): Promise<void> {
    await pool.query(`DELETE FROM operations.document_manifests WHERE object_key=$1`, [objectKey]);
    await pool.query(`DELETE FROM customers.customer_imports WHERE object_key=$1`, [objectKey]);
  }

  private async redactSupport(
    client: pg.PoolClient, merchantId: string, customerId: string, pii: string[],
  ): Promise<void> {
    const messages = await client.query<{ id: string; body: string }>(
      `SELECT id,body FROM customers.support_messages
       WHERE merchant_id=$1 AND (author_id=$2 OR ticket_id IN (
         SELECT ticket_id FROM customers.support_participants WHERE customer_id=$2
       ))`,
      [merchantId, customerId],
    );
    for (const message of messages.rows) {
      await client.query(
        `UPDATE customers.support_messages SET body=$2, attachments='[]'::jsonb WHERE id=$1`,
        [message.id, redactText(message.body, pii) ?? REDACTED],
      );
    }
    const tickets = await client.query<{ id: string; subject: string }>(
      `SELECT t.id,t.subject FROM customers.support_tickets t
       JOIN customers.support_participants p ON p.ticket_id=t.id
       WHERE t.merchant_id=$1 AND p.customer_id=$2`,
      [merchantId, customerId],
    );
    for (const ticket of tickets.rows) {
      const others = await client.query(
        `SELECT 1 FROM customers.support_participants WHERE ticket_id=$1 AND customer_id<>$2`,
        [ticket.id, customerId],
      );
      if (!others.rowCount) {
        await client.query(
          `UPDATE customers.support_tickets SET subject=$2 WHERE id=$1`,
          [ticket.id, redactText(ticket.subject, pii) ?? REDACTED],
        );
      }
    }
  }

  private async sweepRemaining(
    client: pg.PoolClient, merchantId: string, customerId: string, pii: string[],
  ): Promise<void> {
    const unique = pii.filter((value) => value.length >= 5);
    if (unique.length === 0) return;
    const targets: Array<{ table: string; column: string; id: string; extra?: string }> = [
      { table: 'operations.jobs', column: 'payload', id: 'id', extra: 'merchant_id=$1' },
      { table: 'operations.outbox_events', column: 'payload', id: 'id', extra: 'merchant_id=$1' },
      { table: 'operations.analytics_events', column: 'properties', id: 'id', extra: 'merchant_id=$1' },
      { table: 'platform.audit_logs', column: 'metadata', id: 'id', extra: 'merchant_id=$1' },
      { table: 'operations.document_manifests', column: 'metadata', id: 'id', extra: 'merchant_id=$1' },
    ];
    for (const target of targets) {
      const clauses = unique.map((_, index) => `${target.column}::text ILIKE $${index + (target.extra ? 2 : 1)}`);
      const params: unknown[] = target.extra ? [merchantId, ...unique.map((value) => `%${value}%`)] : unique.map((value) => `%${value}%`);
      const where = [target.extra, `(${clauses.join(' OR ')})`].filter(Boolean).join(' AND ');
      const rows = await client.query(`SELECT ${target.id} AS id, ${target.column} AS value FROM ${target.table} WHERE ${where}`, params);
      for (const row of rows.rows as Array<{ id: string; value: unknown }>) {
        await client.query(
          `UPDATE ${target.table} SET ${target.column}=$2 WHERE ${target.id}=$1`,
          [row.id, redactJsonValues(row.value, pii)],
        );
      }
    }
    void customerId;
  }
}
