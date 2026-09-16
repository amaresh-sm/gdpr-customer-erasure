import type pg from 'pg';
import { pool } from '../../../packages/database/src/pool.js';
import type { ErasureRequestRow } from '../../../packages/privacy/src/erasure-contract.js';
import { anonymizedCustomerFields, REDACTED } from '../../../packages/privacy/src/redact.js';

export interface CustomerIdentifiers {
  emails: string[];
  names: string[];
  phones: string[];
}

export interface StoredObject {
  objectKey: string;
  documentType: string | null;
  importId: string | null;
}

export class ErasureRepository {
  async findCustomer(merchantId: string, customerId: string): Promise<{ id: string; status: string } | undefined> {
    const result = await pool.query<{ id: string; status: string }>(
      `SELECT id,status FROM customers.customers WHERE merchant_id=$1 AND id=$2`,
      [merchantId, customerId],
    );
    return result.rows[0];
  }

  async findByCustomer(client: pg.PoolClient, merchantId: string, customerId: string): Promise<ErasureRequestRow | undefined> {
    const result = await client.query<ErasureRequestRow>(
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
       VALUES($1,$2,'pending') RETURNING id,merchant_id,customer_id,status,attempts,last_error,created_at,updated_at,completed_at`,
      [merchantId, customerId],
    );
    return result.rows[0]!;
  }

  async requeue(client: pg.PoolClient, requestId: string): Promise<ErasureRequestRow | undefined> {
    const result = await client.query<ErasureRequestRow>(
      `UPDATE customers.erasure_requests
       SET status='pending', available_at=now(), updated_at=now(), last_error=last_error
       WHERE id=$1 AND status='failed'
       RETURNING id,merchant_id,customer_id,status,attempts,last_error,created_at,updated_at,completed_at`,
      [requestId],
    );
    return result.rows[0];
  }

  async recoverExpiredLeases(): Promise<number> {
    const result = await pool.query(
      `UPDATE customers.erasure_requests
       SET status='pending', available_at=now(), locked_by=NULL, locked_at=NULL, lease_expires_at=NULL,
           last_error=COALESCE(last_error,'worker_lease_expired'), updated_at=now()
       WHERE status='processing' AND lease_expires_at<now()`,
    );
    return result.rowCount ?? 0;
  }

  async claim(workerId: string, leaseSeconds = 180): Promise<ErasureRequestRow | undefined> {
    const result = await pool.query<ErasureRequestRow>(
      `UPDATE customers.erasure_requests
       SET status='processing', attempts=attempts+1, locked_by=$1, locked_at=now(),
           lease_expires_at=now()+($2 || ' seconds')::interval, updated_at=now()
       WHERE id=(SELECT id FROM customers.erasure_requests
         WHERE status IN ('pending','failed') AND available_at<=now()
         ORDER BY available_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1)
       RETURNING id,merchant_id,customer_id,status,attempts,last_error,created_at,updated_at,completed_at`,
      [workerId, leaseSeconds],
    );
    return result.rows[0];
  }

  async markFailed(requestId: string, errorCode: string, delaySeconds: number): Promise<void> {
    await pool.query(
      `UPDATE customers.erasure_requests
       SET status='failed', last_error=$2, available_at=now()+($3 || ' seconds')::interval,
           locked_by=NULL, locked_at=NULL, lease_expires_at=NULL, updated_at=now()
       WHERE id=$1`,
      [requestId, errorCode, delaySeconds],
    );
  }

  async markCompleted(requestId: string): Promise<void> {
    await pool.query(
      `UPDATE customers.erasure_requests
       SET status='completed', last_error=NULL, subject_identifiers=NULL,
           completed_at=COALESCE(completed_at,now()),
           locked_by=NULL, locked_at=NULL, lease_expires_at=NULL, updated_at=now()
       WHERE id=$1`,
      [requestId],
    );
  }

  async insertTombstone(client: pg.PoolClient, merchantId: string, customerId: string, requestId: string): Promise<boolean> {
    const inserted = await client.query(
      `INSERT INTO customers.erasure_tombstones(customer_id,merchant_id,erasure_request_id)
       VALUES($1,$2,$3) ON CONFLICT(customer_id) DO NOTHING RETURNING customer_id`,
      [customerId, merchantId, requestId],
    );
    await client.query(
      `UPDATE customers.customers SET status='erasing', version=version+1, updated_at=now()
       WHERE merchant_id=$1 AND id=$2 AND status='active'`,
      [merchantId, customerId],
    );
    return Boolean(inserted.rowCount);
  }

  async loadIdentifiers(requestId: string): Promise<CustomerIdentifiers | undefined> {
    const result = await pool.query<{ subject_identifiers: CustomerIdentifiers | null }>(
      `SELECT subject_identifiers FROM customers.erasure_requests WHERE id=$1`,
      [requestId],
    );
    const stored = result.rows[0]?.subject_identifiers;
    if (!stored?.emails?.length && !stored?.names?.length && !stored?.phones?.length) return undefined;
    return {
      emails: stored.emails ?? [],
      names: stored.names ?? [],
      phones: stored.phones ?? [],
    };
  }

  async saveIdentifiers(requestId: string, identifiers: CustomerIdentifiers): Promise<void> {
    await pool.query(
      `UPDATE customers.erasure_requests SET subject_identifiers=$2, updated_at=now() WHERE id=$1`,
      [requestId, identifiers],
    );
  }

  async collectIdentifiers(merchantId: string, customerId: string): Promise<CustomerIdentifiers> {
    const [customer, contacts, payments, refunds, invoices, deliveries, notifications, preferences, sandbox] = await Promise.all([
      pool.query<{ email: string; name: string; phone: string | null }>(
        `SELECT email,name,phone FROM customers.customers WHERE merchant_id=$1 AND id=$2`,
        [merchantId, customerId],
      ),
      pool.query<{ value: string }>(
        `SELECT value FROM customers.contacts WHERE merchant_id=$1 AND customer_id=$2`,
        [merchantId, customerId],
      ),
      pool.query<{ email: string | null; name: string | null; phone: string | null }>(
        `SELECT customer_snapshot->>'email' email, customer_snapshot->>'name' name, customer_snapshot->>'phone' phone
         FROM payments.payment_intents WHERE merchant_id=$1 AND customer_id=$2`,
        [merchantId, customerId],
      ),
      pool.query<{ customer_email: string | null }>(
        `SELECT r.customer_email FROM payments.refunds r
         JOIN payments.payment_intents p ON p.id=r.payment_intent_id
         WHERE p.merchant_id=$1 AND p.customer_id=$2`,
        [merchantId, customerId],
      ),
      pool.query<{ email: string | null }>(
        `SELECT billing_snapshot->>'email' email FROM payments.invoices WHERE merchant_id=$1 AND customer_id=$2`,
        [merchantId, customerId],
      ),
      pool.query<{ destination: string }>(
        `SELECT destination FROM operations.email_deliveries WHERE merchant_id=$1 AND customer_id=$2`,
        [merchantId, customerId],
      ),
      pool.query<{ destination: string }>(
        `SELECT destination FROM operations.notifications WHERE merchant_id=$1 AND customer_id=$2`,
        [merchantId, customerId],
      ),
      pool.query<{ destination: string }>(
        `SELECT destination FROM operations.notification_preferences WHERE merchant_id=$1 AND customer_id=$2`,
        [merchantId, customerId],
      ),
      pool.query<{ email: string; name: string }>(
        `SELECT email,name FROM provider_sandbox.customers WHERE merchant_id=$1 AND payflow_customer_id=$2`,
        [merchantId, customerId],
      ),
    ]);

    const emails = [
      ...customer.rows.map((row) => row.email),
      ...contacts.rows.filter((row) => row.value.includes('@')).map((row) => row.value),
      ...payments.rows.map((row) => row.email),
      ...refunds.rows.map((row) => row.customer_email),
      ...invoices.rows.map((row) => row.email),
      ...deliveries.rows.map((row) => row.destination),
      ...notifications.rows.map((row) => row.destination),
      ...preferences.rows.map((row) => row.destination),
      ...sandbox.rows.map((row) => row.email),
    ];
    const names = [
      ...customer.rows.map((row) => row.name),
      ...payments.rows.map((row) => row.name),
      ...sandbox.rows.map((row) => row.name),
    ];
    const phones = [
      ...customer.rows.map((row) => row.phone),
      ...contacts.rows.filter((row) => !row.value.includes('@')).map((row) => row.value),
      ...payments.rows.map((row) => row.phone),
    ];
    return {
      emails: uniqueLower(emails),
      names: uniqueDefined(names),
      phones: uniqueDefined(phones),
    };
  }

  async listStoredObjects(merchantId: string, customerId: string): Promise<StoredObject[]> {
    const [manifests, imports] = await Promise.all([
      pool.query<{ object_key: string; document_type: string }>(
        `SELECT object_key,document_type FROM operations.document_manifests
         WHERE merchant_id=$1 AND (customer_id=$2 OR document_type='customer_import')`,
        [merchantId, customerId],
      ),
      pool.query<{ id: string; object_key: string }>(
        `SELECT id,object_key FROM customers.customer_imports WHERE merchant_id=$1`,
        [merchantId],
      ),
    ]);
    const objects = new Map<string, StoredObject>();
    for (const row of manifests.rows) {
      objects.set(row.object_key, { objectKey: row.object_key, documentType: row.document_type, importId: null });
    }
    for (const row of imports.rows) {
      const existing = objects.get(row.object_key);
      objects.set(row.object_key, {
        objectKey: row.object_key,
        documentType: existing?.documentType ?? 'customer_import',
        importId: row.id,
      });
    }
    return [...objects.values()];
  }

  async deletePersonalRecords(client: pg.PoolClient, merchantId: string, customerId: string): Promise<void> {
    await client.query(`DELETE FROM customers.addresses WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
    await client.query(`DELETE FROM customers.contacts WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
    await client.query(`DELETE FROM customers.payment_method_refs WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
    await client.query(`DELETE FROM customers.provider_customer_mappings WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
    await client.query(
      `UPDATE customers.support_tickets t SET subject=$3
       WHERE t.merchant_id=$1
         AND EXISTS (SELECT 1 FROM customers.support_participants p WHERE p.ticket_id=t.id AND p.customer_id=$2)
         AND NOT EXISTS (SELECT 1 FROM customers.support_participants p WHERE p.ticket_id=t.id AND p.customer_id<>$2)`,
      [merchantId, customerId, REDACTED],
    );
    await client.query(
      `UPDATE customers.support_messages SET author_id=NULL, body=$3
       WHERE merchant_id=$1 AND author_id=$2`,
      [merchantId, customerId, REDACTED],
    );
    await client.query(`DELETE FROM customers.support_participants WHERE customer_id=$1`, [customerId]);
  }

  async redactFinancialRecords(
    client: pg.PoolClient,
    merchantId: string,
    customerId: string,
    redact: (value: unknown) => unknown,
  ): Promise<void> {
    const payments = await client.query<{ id: string; customer_snapshot: unknown; description: string | null }>(
      `SELECT id,customer_snapshot,description FROM payments.payment_intents WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId],
    );
    for (const payment of payments.rows) {
      await client.query(
        `UPDATE payments.payment_intents SET customer_snapshot=$3, description=CASE WHEN description IS NULL THEN NULL ELSE $4 END
         WHERE id=$1 AND merchant_id=$2`,
        [payment.id, merchantId, redact(payment.customer_snapshot), REDACTED],
      );
    }

    await client.query(
      `UPDATE payments.refunds r SET customer_email=$3
       FROM payments.payment_intents p
       WHERE r.payment_intent_id=p.id AND p.merchant_id=$1 AND p.customer_id=$2`,
      [merchantId, customerId, REDACTED],
    );

    const invoices = await client.query<{ id: string; billing_snapshot: unknown }>(
      `SELECT id,billing_snapshot FROM payments.invoices WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId],
    );
    for (const invoice of invoices.rows) {
      await client.query(
        `UPDATE payments.invoices SET billing_snapshot=$3 WHERE id=$1 AND merchant_id=$2`,
        [invoice.id, merchantId, redact(invoice.billing_snapshot)],
      );
    }

    const attempts = await client.query<{ id: string; request_payload: unknown; response_payload: unknown }>(
      `SELECT a.id,a.request_payload,a.response_payload
       FROM payments.payment_attempts a
       JOIN payments.payment_intents p ON p.id=a.payment_intent_id
       WHERE p.merchant_id=$1 AND p.customer_id=$2`,
      [merchantId, customerId],
    );
    for (const attempt of attempts.rows) {
      const requestPayload = redact(attempt.request_payload) as Record<string, unknown> | null;
      if (requestPayload && requestPayload.description != null) requestPayload.description = REDACTED;
      await client.query(
        `UPDATE payments.payment_attempts SET request_payload=$2, response_payload=$3 WHERE id=$1`,
        [attempt.id, requestPayload, attempt.response_payload ? redact(attempt.response_payload) : null],
      );
    }

    const disputes = await client.query<{ id: string; evidence: unknown }>(
      `SELECT d.id,d.evidence FROM payments.disputes d
       JOIN payments.payment_intents p ON p.id=d.payment_intent_id
       WHERE p.merchant_id=$1 AND p.customer_id=$2`,
      [merchantId, customerId],
    );
    for (const dispute of disputes.rows) {
      await client.query(`UPDATE payments.disputes SET evidence=$2 WHERE id=$1`, [dispute.id, redact(dispute.evidence)]);
    }
  }

  async redactOperationalRecords(
    client: pg.PoolClient,
    merchantId: string,
    customerId: string,
    emails: string[],
    redact: (value: unknown) => unknown,
  ): Promise<void> {
    const outbox = await client.query<{ id: string; payload: unknown }>(
      `SELECT id,payload FROM operations.outbox_events
       WHERE merchant_id=$1 AND (
         aggregate_id=$2 OR payload->>'customerId'=$2::text
         OR EXISTS (SELECT 1 FROM unnest($3::text[]) email WHERE position(email in lower(payload::text)) > 0)
       )`,
      [merchantId, customerId, emails],
    );
    for (const event of outbox.rows) {
      await client.query(`UPDATE operations.outbox_events SET payload=$2 WHERE id=$1`, [event.id, redact(event.payload)]);
    }

    const jobs = await client.query<{ id: string; payload: unknown }>(
      `SELECT id,payload FROM operations.jobs
       WHERE merchant_id=$1 AND (
         payload->>'customerId'=$2::text
         OR EXISTS (SELECT 1 FROM unnest($3::text[]) email WHERE position(email in lower(payload::text)) > 0)
       )`,
      [merchantId, customerId, emails],
    );
    for (const job of jobs.rows) {
      await client.query(`UPDATE operations.jobs SET payload=$2 WHERE id=$1`, [job.id, redact(job.payload)]);
    }

    await client.query(
      `UPDATE operations.email_deliveries
       SET destination=$3, subject=$3, text_body=$3, html_body=$3,
           status=CASE WHEN status IN ('pending','failed','processing') THEN 'cancelled' ELSE status END,
           cancelled_at=CASE WHEN status IN ('pending','failed','processing') THEN now() ELSE cancelled_at END,
           locked_by=NULL, locked_at=NULL, lease_expires_at=NULL
       WHERE merchant_id=$1 AND (customer_id=$2 OR lower(destination) = ANY($4::text[]))`,
      [merchantId, customerId, REDACTED, emails],
    );
    await client.query(
      `UPDATE operations.notifications
       SET destination=$3, payload=$4, status=CASE WHEN status IN ('queued','retrying','pending') THEN 'cancelled' ELSE status END
       WHERE merchant_id=$1 AND (customer_id=$2 OR lower(destination) = ANY($5::text[]))`,
      [merchantId, customerId, REDACTED, {}, emails],
    );
    await client.query(
      `DELETE FROM operations.notification_preferences WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId],
    );

    const analytics = await client.query<{ id: string; properties: unknown }>(
      `SELECT id,properties FROM operations.analytics_events WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId],
    );
    for (const event of analytics.rows) {
      await client.query(
        `UPDATE operations.analytics_events SET email=NULL, properties=$2 WHERE id=$1`,
        [event.id, redact(event.properties)],
      );
    }

    const audits = await client.query<{ id: string; metadata: unknown }>(
      `SELECT id,metadata FROM platform.audit_logs
       WHERE merchant_id=$1 AND (
         target_id=$2::text
         OR EXISTS (SELECT 1 FROM unnest($3::text[]) email WHERE position(email in lower(metadata::text)) > 0)
       )`,
      [merchantId, customerId, emails],
    );
    for (const audit of audits.rows) {
      await client.query(`UPDATE platform.audit_logs SET metadata=$2 WHERE id=$1`, [audit.id, redact(audit.metadata)]);
    }

    const deadLetters = await client.query<{ id: string; payload: unknown }>(
      `SELECT id,payload FROM operations.dead_letters
       WHERE payload->>'customerId'=$1::text OR payload->>'customer_id'=$1::text`,
      [customerId],
    );
    for (const letter of deadLetters.rows) {
      await client.query(`UPDATE operations.dead_letters SET payload=$2 WHERE id=$1`, [letter.id, redact(letter.payload)]);
    }
  }

  async anonymizeCustomer(client: pg.PoolClient, merchantId: string, customerId: string): Promise<void> {
    const fields = anonymizedCustomerFields(customerId);
    await client.query(
      `UPDATE customers.customers
       SET email=$3, name=$4, phone=$5, external_reference=$6, metadata='{}'::jsonb,
           status='erased', version=version+1, updated_at=now()
       WHERE merchant_id=$1 AND id=$2 AND status<>'erased'`,
      [merchantId, customerId, fields.email, fields.name, fields.phone, fields.external_reference],
    );
    await client.query(
      `UPDATE provider_sandbox.customers
       SET email=$3, name=$4, external_reference=$5, updated_at=now()
       WHERE merchant_id=$1 AND payflow_customer_id=$2`,
      [merchantId, customerId, fields.email, fields.name, fields.external_reference],
    );
  }

  async updateManifestChecksum(client: pg.PoolClient, merchantId: string, objectKey: string, checksum: string): Promise<void> {
    await client.query(
      `UPDATE operations.document_manifests SET checksum=$3 WHERE merchant_id=$1 AND object_key=$2`,
      [merchantId, objectKey, checksum],
    );
  }

  async remainingPersonalData(merchantId: string, customerId: string, identifiers: CustomerIdentifiers): Promise<string[]> {
    const leftovers: string[] = [];
    const customer = await pool.query<{ email: string; name: string; phone: string | null; status: string }>(
      `SELECT email,name,phone,status FROM customers.customers WHERE merchant_id=$1 AND id=$2`,
      [merchantId, customerId],
    );
    const row = customer.rows[0];
    if (!row) {
      leftovers.push('customer_missing');
      return leftovers;
    }
    if (row.status !== 'erased') leftovers.push('customer_not_erased');
    if (identifiers.emails.includes(row.email.toLowerCase())) leftovers.push('customer_email');
    if (identifiers.names.includes(row.name)) leftovers.push('customer_name');
    if (row.phone && identifiers.phones.includes(row.phone)) leftovers.push('customer_phone');

    const related = await pool.query<{ leftover: string }>(`
      SELECT leftover FROM (
        SELECT 'address' leftover FROM customers.addresses WHERE merchant_id=$1 AND customer_id=$2
        UNION ALL SELECT 'contact' FROM customers.contacts WHERE merchant_id=$1 AND customer_id=$2
        UNION ALL SELECT 'payment_method' FROM customers.payment_method_refs WHERE merchant_id=$1 AND customer_id=$2
        UNION ALL SELECT 'provider_mapping' FROM customers.provider_customer_mappings WHERE merchant_id=$1 AND customer_id=$2
        UNION ALL SELECT 'support_participant' FROM customers.support_participants WHERE customer_id=$2
        UNION ALL SELECT 'notification_preference' FROM operations.notification_preferences WHERE merchant_id=$1 AND customer_id=$2
        UNION ALL SELECT 'payment_snapshot'
          FROM payments.payment_intents
          WHERE merchant_id=$1 AND customer_id=$2
            AND (
              lower(COALESCE(customer_snapshot->>'email','')) = ANY($3::text[])
              OR COALESCE(customer_snapshot->>'name','') = ANY($4::text[])
            )
        UNION ALL SELECT 'refund_email'
          FROM payments.refunds r JOIN payments.payment_intents p ON p.id=r.payment_intent_id
          WHERE p.merchant_id=$1 AND p.customer_id=$2 AND lower(COALESCE(r.customer_email,'')) = ANY($3::text[])
        UNION ALL SELECT 'invoice_snapshot'
          FROM payments.invoices
          WHERE merchant_id=$1 AND customer_id=$2
            AND lower(COALESCE(billing_snapshot->>'email','')) = ANY($3::text[])
        UNION ALL SELECT 'payment_description'
          FROM payments.payment_intents
          WHERE merchant_id=$1 AND customer_id=$2 AND COALESCE(description,'') = ANY($4::text[])
        UNION ALL SELECT 'email_delivery'
          FROM operations.email_deliveries
          WHERE merchant_id=$1 AND customer_id=$2 AND lower(destination) = ANY($3::text[])
        UNION ALL SELECT 'notification'
          FROM operations.notifications
          WHERE merchant_id=$1 AND customer_id=$2 AND lower(destination) = ANY($3::text[])
        UNION ALL SELECT 'analytics_email'
          FROM operations.analytics_events
          WHERE merchant_id=$1 AND customer_id=$2 AND lower(COALESCE(email,'')) = ANY($3::text[])
        UNION ALL SELECT 'provider_customer'
          FROM provider_sandbox.customers
          WHERE merchant_id=$1 AND payflow_customer_id=$2 AND lower(email) = ANY($3::text[])
      ) remaining LIMIT 20
    `, [merchantId, customerId, identifiers.emails, identifiers.names]);
    leftovers.push(...related.rows.map((item) => item.leftover));

    const emails = identifiers.emails.filter((email) => email.includes('@') && !email.endsWith('@invalid.example'));
    if (emails.length) {
      const scattered = await pool.query<{ leftover: string }>(`
        SELECT leftover FROM (
          SELECT 'outbox_payload' leftover FROM operations.outbox_events
            WHERE merchant_id=$1 AND EXISTS (
              SELECT 1 FROM unnest($3::text[]) email WHERE position(email in lower(payload::text)) > 0
            )
          UNION ALL SELECT 'job_payload' FROM operations.jobs
            WHERE merchant_id=$1 AND EXISTS (
              SELECT 1 FROM unnest($3::text[]) email WHERE position(email in lower(payload::text)) > 0
            )
          UNION ALL SELECT 'audit_metadata' FROM platform.audit_logs
            WHERE merchant_id=$1 AND EXISTS (
              SELECT 1 FROM unnest($3::text[]) email WHERE position(email in lower(metadata::text)) > 0
            )
          UNION ALL SELECT 'analytics_properties' FROM operations.analytics_events
            WHERE merchant_id=$1 AND customer_id=$2 AND EXISTS (
              SELECT 1 FROM unnest($3::text[]) email WHERE position(email in lower(COALESCE(properties::text,''))) > 0
            )
        ) scattered LIMIT 20
      `, [merchantId, customerId, emails]);
      leftovers.push(...scattered.rows.map((item) => item.leftover));
    }
    return leftovers;
  }

  async audit(
    client: pg.PoolClient,
    merchantId: string,
    customerId: string,
    action: string,
    correlationId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await client.query(
      `INSERT INTO platform.audit_logs(merchant_id,actor_type,target_type,target_id,action,metadata,correlation_id)
       VALUES($1,'api_key','customer',$2,$3,$4,$5)`,
      [merchantId, customerId, action, metadata, correlationId],
    );
  }
}

function uniqueLower(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim().toLowerCase()).filter((value): value is string => Boolean(value)))];
}

function uniqueDefined(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}
