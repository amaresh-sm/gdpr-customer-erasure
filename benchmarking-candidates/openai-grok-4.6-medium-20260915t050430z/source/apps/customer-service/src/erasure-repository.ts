import type pg from 'pg';
import { pool } from '../../../packages/database/src/pool.js';
import { anonymizedCustomerIdentity, anonymizedCustomerSnapshot, stripPii } from '../../../packages/privacy/src/redact.js';

export type ErasureStatus = 'pending' | 'processing' | 'failed' | 'completed';

export interface ErasureRequestRow {
  id: string;
  merchant_id: string;
  customer_id: string;
  status: ErasureStatus;
  attempts: number;
  last_error: string | null;
  pii_targets: PiiTargets;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

export interface PiiTargets {
  email?: string | null;
  destinations?: string[];
  objectKeys?: string[];
  importIds?: string[];
}

export interface ClaimedErasureRequest extends ErasureRequestRow {
  workerId: string;
}

function iso(value: Date | string | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function toErasureResponse(row: ErasureRequestRow): Record<string, unknown> {
  return {
    id: row.id,
    customerId: row.customer_id,
    status: row.status,
    attempts: row.attempts,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    completedAt: iso(row.completed_at),
    lastError: row.last_error,
  };
}

export class ErasureRepository {
  async findCustomer(client: pg.PoolClient, merchantId: string, customerId: string): Promise<{
    id: string;
    email: string;
    name: string;
    phone: string | null;
    status: string;
  } | undefined> {
    const result = await client.query<{
      id: string; email: string; name: string; phone: string | null; status: string;
    }>(
      `SELECT id,email,name,phone,status FROM customers.customers
       WHERE merchant_id=$1 AND id=$2 FOR UPDATE`,
      [merchantId, customerId],
    );
    return result.rows[0];
  }

  async findByCustomer(client: pg.PoolClient, merchantId: string, customerId: string): Promise<ErasureRequestRow | undefined> {
    const result = await client.query<ErasureRequestRow>(
      `SELECT id,merchant_id,customer_id,status,attempts,last_error,pii_targets,created_at,updated_at,completed_at
       FROM customers.erasure_requests WHERE merchant_id=$1 AND customer_id=$2 FOR UPDATE`,
      [merchantId, customerId],
    );
    return result.rows[0];
  }

  async findById(merchantId: string, requestId: string): Promise<ErasureRequestRow | undefined> {
    const result = await pool.query<ErasureRequestRow>(
      `SELECT id,merchant_id,customer_id,status,attempts,last_error,pii_targets,created_at,updated_at,completed_at
       FROM customers.erasure_requests WHERE merchant_id=$1 AND id=$2`,
      [merchantId, requestId],
    );
    return result.rows[0];
  }

  async captureTargets(client: pg.PoolClient, merchantId: string, customerId: string, email: string): Promise<PiiTargets> {
    const destinations = await client.query<{ destination: string }>(
      `SELECT DISTINCT destination FROM (
         SELECT destination FROM operations.email_deliveries
         WHERE merchant_id=$1 AND customer_id=$2 AND destination IS NOT NULL
         UNION
         SELECT destination FROM operations.notifications
         WHERE merchant_id=$1 AND customer_id=$2 AND destination IS NOT NULL
         UNION
         SELECT destination FROM operations.notification_preferences
         WHERE merchant_id=$1 AND customer_id=$2 AND destination IS NOT NULL
       ) destinations`,
      [merchantId, customerId],
    );
    const objects = await client.query<{ object_key: string }>(
      `SELECT object_key FROM operations.document_manifests
       WHERE merchant_id=$1 AND (customer_id=$2 OR metadata->>'customerId'=$2)
       UNION
       SELECT object_key FROM payments.invoices WHERE merchant_id=$1 AND customer_id=$2 AND object_key IS NOT NULL`,
      [merchantId, customerId],
    );
    const imports = await client.query<{ id: string }>(
      `SELECT ci.id FROM customers.customer_imports ci
       JOIN operations.document_manifests d ON d.object_key=ci.object_key
       WHERE ci.merchant_id=$1 AND (d.customer_id=$2 OR d.metadata->>'customerId'=$2)`,
      [merchantId, customerId],
    );
    const collected = new Set<string>([email, ...destinations.rows.map((row) => row.destination)]);
    return {
      email,
      destinations: [...collected].filter(Boolean),
      objectKeys: objects.rows.map((row) => row.object_key),
      importIds: imports.rows.map((row) => row.id),
    };
  }

  async create(
    client: pg.PoolClient,
    merchantId: string,
    customerId: string,
    targets: PiiTargets,
  ): Promise<ErasureRequestRow> {
    const identity = anonymizedCustomerIdentity(customerId);
    await client.query(
      `UPDATE customers.customers
       SET email=$3,name=$4,phone=NULL,external_reference=$5,metadata='{}',status='erased',version=version+1,updated_at=now()
       WHERE merchant_id=$1 AND id=$2`,
      [merchantId, customerId, identity.email, identity.name, identity.externalReference],
    );
    const request = await client.query<ErasureRequestRow>(
      `INSERT INTO customers.erasure_requests(merchant_id,customer_id,status,pii_targets)
       VALUES($1,$2,'pending',$3)
       RETURNING id,merchant_id,customer_id,status,attempts,last_error,pii_targets,created_at,updated_at,completed_at`,
      [merchantId, customerId, targets],
    );
    const row = request.rows[0]!;
    await client.query(
      `INSERT INTO customers.erasure_tombstones(merchant_id,customer_id,erasure_request_id)
       VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
      [merchantId, customerId, row.id],
    );
    return row;
  }

  async requeue(client: pg.PoolClient, requestId: string): Promise<ErasureRequestRow> {
    const result = await client.query<ErasureRequestRow>(
      `UPDATE customers.erasure_requests
       SET status='pending',available_at=now(),last_error=NULL,updated_at=now(),
           locked_by=NULL,locked_at=NULL,lease_expires_at=NULL
       WHERE id=$1
       RETURNING id,merchant_id,customer_id,status,attempts,last_error,pii_targets,created_at,updated_at,completed_at`,
      [requestId],
    );
    return result.rows[0]!;
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

  async claim(workerId: string, leaseSeconds = 60): Promise<ClaimedErasureRequest | undefined> {
    const result = await pool.query<ErasureRequestRow>(
      `UPDATE customers.erasure_requests
       SET status='processing',attempts=attempts+1,locked_by=$1,locked_at=now(),
           lease_expires_at=now()+($2 || ' seconds')::interval,last_error=NULL,updated_at=now()
       WHERE id=(SELECT id FROM customers.erasure_requests
         WHERE status IN ('pending','failed') AND available_at<=now()
         ORDER BY available_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1)
       RETURNING id,merchant_id,customer_id,status,attempts,last_error,pii_targets,created_at,updated_at,completed_at`,
      [workerId, leaseSeconds],
    );
    const row = result.rows[0];
    return row ? { ...row, workerId } : undefined;
  }

  async complete(client: pg.PoolClient, request: ClaimedErasureRequest): Promise<void> {
    await client.query(
      `UPDATE customers.erasure_requests
       SET status='completed',completed_at=now(),updated_at=now(),last_error=NULL,
           locked_by=NULL,locked_at=NULL,lease_expires_at=NULL
       WHERE id=$1 AND locked_by=$2`,
      [request.id, request.workerId],
    );
  }

  async fail(request: ClaimedErasureRequest, errorCode: string): Promise<void> {
    const delay = Math.min(300, 2 ** Math.max(0, request.attempts));
    await pool.query(
      `UPDATE customers.erasure_requests
       SET status='failed',available_at=now()+($3 || ' seconds')::interval,last_error=$4,
           locked_by=NULL,locked_at=NULL,lease_expires_at=NULL,updated_at=now()
       WHERE id=$1 AND locked_by=$2`,
      [request.id, request.workerId, delay, errorCode],
    );
  }

  async eraseOperationalRecords(client: pg.PoolClient, merchantId: string, customerId: string): Promise<void> {
    const snapshot = anonymizedCustomerSnapshot(customerId);
    await client.query(
      `DELETE FROM customers.addresses WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId],
    );
    await client.query(
      `DELETE FROM customers.contacts WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId],
    );
    await client.query(
      `DELETE FROM customers.payment_method_refs WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId],
    );
    await client.query(
      `DELETE FROM customers.provider_customer_mappings WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId],
    );
    await client.query(
      `UPDATE customers.support_messages SET body='[redacted]',author_id=NULL,attachments='[]'
       WHERE merchant_id=$1 AND author_id=$2`,
      [merchantId, customerId],
    );
    await client.query(
      `DELETE FROM customers.support_participants WHERE customer_id=$1`,
      [customerId],
    );
    await client.query(
      `UPDATE customers.support_tickets SET subject='[redacted]'
       WHERE merchant_id=$1 AND NOT EXISTS (
         SELECT 1 FROM customers.support_participants p WHERE p.ticket_id=customers.support_tickets.id
       )`,
      [merchantId],
    );

    await client.query(
      `UPDATE payments.payment_intents
       SET customer_snapshot=$3,description=CASE WHEN description IS NULL THEN NULL ELSE '[redacted]' END,updated_at=now()
       WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId, snapshot],
    );
    await client.query(
      `UPDATE payments.refunds SET customer_email=NULL
       WHERE merchant_id=$1 AND payment_intent_id IN (
         SELECT id FROM payments.payment_intents WHERE merchant_id=$1 AND customer_id=$2
       )`,
      [merchantId, customerId],
    );
    await client.query(
      `UPDATE payments.invoices SET billing_snapshot=$3
       WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId, snapshot],
    );
    await client.query(
      `UPDATE payments.disputes SET evidence='{}'
       WHERE merchant_id=$1 AND payment_intent_id IN (
         SELECT id FROM payments.payment_intents WHERE merchant_id=$1 AND customer_id=$2
       )`,
      [merchantId, customerId],
    );

    await client.query(
      `UPDATE operations.analytics_events
       SET email=NULL,properties=$3
       WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId, { erased: true }],
    );
    await client.query(
      `DELETE FROM operations.notification_preferences WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId],
    );
    await client.query(
      `UPDATE operations.notifications
       SET destination='redacted@erased.invalid',payload=$3,updated_at=now()
       WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId, { erased: true }],
    );
    await client.query(
      `UPDATE operations.email_deliveries
       SET destination='redacted@erased.invalid',subject='[redacted]',text_body='[redacted]',html_body='[redacted]',
           status=CASE WHEN status IN ('pending','processing','failed') THEN 'cancelled' ELSE status END,
           cancelled_at=COALESCE(cancelled_at,now())
       WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId],
    );
    await client.query(
      `UPDATE platform.audit_logs
       SET metadata=$3
       WHERE merchant_id=$1 AND (target_id=$2 OR metadata->>'customerId'=$2)`,
      [merchantId, customerId, { erased: true }],
    );
    await this.redactDocumentMetadata(client, merchantId, customerId);
    await this.redactJsonRows(client, merchantId, customerId);
    await client.query(
      `UPDATE provider_sandbox.customers
       SET email=$3,name='Erased Customer',external_reference=$4,updated_at=now()
       WHERE merchant_id=$1 AND payflow_customer_id=$2`,
      [merchantId, customerId, anonymizedCustomerIdentity(customerId).email, `erased:${customerId}`],
    );
  }

  async listImportArtifacts(merchantId: string): Promise<Array<{ id: string; object_key: string }>> {
    const result = await pool.query<{ id: string; object_key: string }>(
      `SELECT id,object_key FROM customers.customer_imports WHERE merchant_id=$1`,
      [merchantId],
    );
    return result.rows;
  }

  async listCustomerDocuments(merchantId: string, customerId: string): Promise<Array<{ object_key: string; document_type: string }>> {
    const result = await pool.query<{ object_key: string; document_type: string }>(
      `SELECT object_key,document_type FROM operations.document_manifests
       WHERE merchant_id=$1 AND (customer_id=$2 OR metadata->>'customerId'=$2)`,
      [merchantId, customerId],
    );
    return result.rows;
  }

  async deleteImportArtifacts(
    client: pg.PoolClient,
    merchantId: string,
    importIds: string[],
  ): Promise<void> {
    if (!importIds.length) return;
    await client.query(
      `DELETE FROM customers.customer_imports WHERE merchant_id=$1 AND id=ANY($2::uuid[])`,
      [merchantId, importIds],
    );
    await client.query(
      `DELETE FROM operations.document_manifests
       WHERE merchant_id=$1 AND document_type='customer_import'
         AND metadata->>'importId'=ANY($2::text[])`,
      [merchantId, importIds],
    );
  }

  async updateDocumentChecksum(client: pg.PoolClient, objectKey: string, checksum: string): Promise<void> {
    await client.query(
      `UPDATE operations.document_manifests
       SET checksum=$2,metadata=COALESCE(metadata,'{}') - 'email' - 'name' - 'customerEmail' - 'phone'
       WHERE object_key=$1`,
      [objectKey, checksum],
    );
  }

  async redactDocumentMetadata(client: pg.PoolClient, merchantId: string, customerId: string): Promise<void> {
    await client.query(
      `UPDATE operations.document_manifests
       SET metadata=COALESCE(metadata,'{}') - 'email' - 'name' - 'customerEmail' - 'phone'
       WHERE merchant_id=$1 AND (customer_id=$2 OR metadata->>'customerId'=$2)`,
      [merchantId, customerId],
    );
  }

  private async redactJsonRows(client: pg.PoolClient, merchantId: string, customerId: string): Promise<void> {
    const outbox = await client.query<{ id: string; payload: unknown }>(
      `SELECT id,payload FROM operations.outbox_events
       WHERE merchant_id=$1 AND (aggregate_id=$2 OR payload->>'customerId'=$2)`,
      [merchantId, customerId],
    );
    for (const row of outbox.rows) {
      await client.query(`UPDATE operations.outbox_events SET payload=$2 WHERE id=$1`, [row.id, stripPii(row.payload)]);
    }

    const jobs = await client.query<{ id: string; payload: Record<string, unknown> }>(
      `SELECT id,payload FROM operations.jobs
       WHERE merchant_id=$1 AND payload->>'customerId'=$2`,
      [merchantId, customerId],
    );
    for (const row of jobs.rows) {
      const payload = stripPii(row.payload) as Record<string, unknown>;
      if (payload.customerSnapshot && typeof payload.customerSnapshot === 'object') {
        payload.customerSnapshot = anonymizedCustomerSnapshot(customerId);
      }
      await client.query(`UPDATE operations.jobs SET payload=$2 WHERE id=$1`, [row.id, payload]);
    }

    const letters = await client.query<{ id: string; payload: unknown }>(
      `SELECT id,payload FROM operations.dead_letters
       WHERE payload->>'customerId'=$1 OR payload->>'customer_id'=$1`,
      [customerId],
    );
    for (const row of letters.rows) {
      const payload = row.payload as Record<string, unknown> | null;
      if (payload && (payload.customerId === customerId || payload.customer_id === customerId)) {
        await client.query(`UPDATE operations.dead_letters SET payload=$2 WHERE id=$1`, [row.id, stripPii(payload)]);
      }
    }

    const attempts = await client.query<{ id: string; request_payload: unknown; response_payload: unknown }>(
      `SELECT a.id,a.request_payload,a.response_payload
       FROM payments.payment_attempts a
       JOIN payments.payment_intents p ON p.id=a.payment_intent_id
       WHERE a.merchant_id=$1 AND p.customer_id=$2`,
      [merchantId, customerId],
    );
    for (const row of attempts.rows) {
      const requestPayload = stripPii(row.request_payload) as Record<string, unknown> | null;
      if (requestPayload && typeof requestPayload.description === 'string') requestPayload.description = '[redacted]';
      await client.query(
        `UPDATE payments.payment_attempts SET request_payload=$2,response_payload=$3 WHERE id=$1`,
        [row.id, requestPayload, stripPii(row.response_payload)],
      );
    }
  }

  async audit(
    client: pg.PoolClient,
    merchantId: string,
    customerId: string,
    request: ErasureRequestRow,
  ): Promise<void> {
    await client.query(
      `INSERT INTO platform.audit_logs(merchant_id,actor_type,target_type,target_id,action,metadata,correlation_id)
       VALUES($1,'api_key','customer',$2,'customer.erasure.requested',$3,$4)`,
      [merchantId, customerId, { requestId: request.id, status: request.status }, request.id],
    );
  }
}
