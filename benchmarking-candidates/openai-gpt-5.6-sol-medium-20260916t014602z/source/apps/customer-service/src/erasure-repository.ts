import type { PoolClient } from 'pg';
import { pool } from '../../../packages/database/src/pool.js';
import { redactPii, retainedCustomerSnapshot } from '../../../packages/privacy/src/redact.js';

export type ErasureStatus = 'pending' | 'processing' | 'failed' | 'completed';

export interface CleanupTargets {
  email?: string;
  destinations?: string[];
  objectKeys?: string[];
  identityValues?: string[];
}

export interface ErasureRow {
  id: string;
  merchant_id: string;
  customer_id: string;
  status: ErasureStatus;
  attempts: number;
  last_error: string | null;
  cleanup_targets: CleanupTargets;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

export interface ClaimedErasure extends ErasureRow {
  workerId: string;
}

export function presentErasure(row: ErasureRow): Record<string, unknown> {
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

const REQUEST_COLUMNS = `id,merchant_id,customer_id,status,attempts,last_error,cleanup_targets,
  created_at,updated_at,completed_at`;

export class ErasureRepository {
  async lockMerchant(client: PoolClient, merchantId: string): Promise<void> {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`erasure:${merchantId}`]);
  }

  async findKey(client: PoolClient, merchantId: string, key: string): Promise<{
    customer_id: string;
    request_id: string;
  } | undefined> {
    const result = await client.query<{ customer_id: string; request_id: string }>(
      `SELECT customer_id,request_id FROM customers.erasure_idempotency_keys
       WHERE merchant_id=$1 AND key=$2`,
      [merchantId, key],
    );
    return result.rows[0];
  }

  async findCustomer(client: PoolClient, merchantId: string, customerId: string): Promise<{
    id: string;
    email: string;
  } | undefined> {
    const result = await client.query<{ id: string; email: string }>(
      `SELECT id,email FROM customers.customers WHERE merchant_id=$1 AND id=$2 FOR UPDATE`,
      [merchantId, customerId],
    );
    return result.rows[0];
  }

  async findByCustomer(
    client: PoolClient,
    merchantId: string,
    customerId: string,
  ): Promise<ErasureRow | undefined> {
    const result = await client.query<ErasureRow>(
      `SELECT ${REQUEST_COLUMNS} FROM customers.erasure_requests
       WHERE merchant_id=$1 AND customer_id=$2 FOR UPDATE`,
      [merchantId, customerId],
    );
    return result.rows[0];
  }

  async findByRequest(client: PoolClient, requestId: string): Promise<ErasureRow> {
    const result = await client.query<ErasureRow>(
      `SELECT ${REQUEST_COLUMNS} FROM customers.erasure_requests WHERE id=$1`,
      [requestId],
    );
    return result.rows[0]!;
  }

  async find(merchantId: string, requestId: string): Promise<ErasureRow | undefined> {
    const result = await pool.query<ErasureRow>(
      `SELECT ${REQUEST_COLUMNS} FROM customers.erasure_requests WHERE merchant_id=$1 AND id=$2`,
      [merchantId, requestId],
    );
    return result.rows[0];
  }

  async captureTargets(
    client: PoolClient,
    merchantId: string,
    customerId: string,
    email: string,
  ): Promise<CleanupTargets> {
    const destinations = await client.query<{ destination: string }>(
      `SELECT destination FROM operations.email_deliveries WHERE merchant_id=$1 AND customer_id=$2
       UNION SELECT destination FROM operations.notifications WHERE merchant_id=$1 AND customer_id=$2
       UNION SELECT destination FROM operations.notification_preferences WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId],
    );
    const objects = await client.query<{ object_key: string }>(
      `SELECT object_key FROM operations.document_manifests
       WHERE merchant_id=$1 AND (customer_id=$2 OR metadata->>'customerId'=$2)
       UNION SELECT object_key FROM payments.invoices
       WHERE merchant_id=$1 AND customer_id=$2 AND object_key IS NOT NULL`,
      [merchantId, customerId],
    );
    return {
      email,
      destinations: [...new Set([email, ...destinations.rows.map((row) => row.destination)].filter(Boolean))],
      objectKeys: [...new Set(objects.rows.map((row) => row.object_key))],
    };
  }

  async create(
    client: PoolClient,
    merchantId: string,
    customerId: string,
    key: string,
    targets: CleanupTargets,
  ): Promise<ErasureRow> {
    const result = await client.query<ErasureRow>(
      `INSERT INTO customers.erasure_requests(merchant_id,customer_id,cleanup_targets)
       VALUES($1,$2,$3) RETURNING ${REQUEST_COLUMNS}`,
      [merchantId, customerId, targets],
    );
    const request = result.rows[0]!;
    await client.query(
      `INSERT INTO customers.erasure_idempotency_keys(merchant_id,key,customer_id,request_id)
       VALUES($1,$2,$3,$4)`,
      [merchantId, key, customerId, request.id],
    );
    await client.query(
      `INSERT INTO customers.erasure_tombstones(merchant_id,customer_id,request_id)
       VALUES($1,$2,$3)`,
      [merchantId, customerId, request.id],
    );
    await client.query(
      `UPDATE customers.customers SET external_reference='erased:'||id::text,
       email='erased+'||id::text||'@invalid.local',name='Erased Customer',phone=NULL,
       metadata='{}',status='erasing',version=version+1,updated_at=now()
       WHERE merchant_id=$1 AND id=$2`,
      [merchantId, customerId],
    );
    return request;
  }

  async addKey(
    client: PoolClient,
    merchantId: string,
    customerId: string,
    key: string,
    requestId: string,
  ): Promise<void> {
    await client.query(
      `INSERT INTO customers.erasure_idempotency_keys(merchant_id,key,customer_id,request_id)
       VALUES($1,$2,$3,$4)`,
      [merchantId, key, customerId, requestId],
    );
  }

  async requeue(client: PoolClient, requestId: string): Promise<ErasureRow> {
    const result = await client.query<ErasureRow>(
      `UPDATE customers.erasure_requests SET status='pending',available_at=now(),last_error=NULL,
       locked_by=NULL,locked_at=NULL,lease_expires_at=NULL,updated_at=now()
       WHERE id=$1 RETURNING ${REQUEST_COLUMNS}`,
      [requestId],
    );
    return result.rows[0]!;
  }

  async claim(workerId: string): Promise<ClaimedErasure | undefined> {
    const result = await pool.query<ErasureRow>(
      `UPDATE customers.erasure_requests SET status='processing',attempts=attempts+1,
       locked_by=$1,locked_at=now(),lease_expires_at=now()+interval '60 seconds',
       last_error=NULL,updated_at=now()
       WHERE id=(SELECT id FROM customers.erasure_requests
         WHERE status IN ('pending','failed') AND available_at<=now()
         ORDER BY available_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1)
       RETURNING ${REQUEST_COLUMNS}`,
      [workerId],
    );
    return result.rows[0] ? { ...result.rows[0], workerId } : undefined;
  }

  async recoverExpiredLeases(): Promise<void> {
    await pool.query(
      `UPDATE customers.erasure_requests SET status='failed',available_at=now(),
       locked_by=NULL,locked_at=NULL,lease_expires_at=NULL,last_error='worker_lease_expired',updated_at=now()
       WHERE status='processing' AND lease_expires_at<now()`,
    );
  }

  async fail(request: ClaimedErasure, code: string): Promise<void> {
    await pool.query(
      `UPDATE customers.erasure_requests SET status='failed',
       available_at=now()+($3||' seconds')::interval,last_error=$4,
       locked_by=NULL,locked_at=NULL,lease_expires_at=NULL,updated_at=now()
       WHERE id=$1 AND locked_by=$2`,
      [request.id, request.workerId, Math.min(300, 2 ** Math.min(request.attempts, 8)), code],
    );
  }

  async complete(client: PoolClient, request: ClaimedErasure): Promise<void> {
    await client.query(
      `UPDATE customers.erasure_requests SET status='completed',cleanup_targets='{}',
       completed_at=now(),updated_at=now(),last_error=NULL,
       locked_by=NULL,locked_at=NULL,lease_expires_at=NULL
       WHERE id=$1 AND locked_by=$2`,
      [request.id, request.workerId],
    );
  }

  async listImports(merchantId: string): Promise<Array<{ id: string; object_key: string }>> {
    const result = await pool.query<{ id: string; object_key: string }>(
      `SELECT id,object_key FROM customers.customer_imports WHERE merchant_id=$1`,
      [merchantId],
    );
    return result.rows;
  }

  async deleteImports(client: PoolClient, merchantId: string, objectKeys: string[]): Promise<void> {
    if (!objectKeys.length) return;
    await client.query(
      `DELETE FROM customers.customer_imports WHERE merchant_id=$1 AND object_key=ANY($2::text[])`,
      [merchantId, objectKeys],
    );
    await client.query(
      `DELETE FROM operations.document_manifests WHERE merchant_id=$1 AND object_key=ANY($2::text[])`,
      [merchantId, objectKeys],
    );
  }

  async updateDocumentChecksum(client: PoolClient, objectKey: string, checksum: string): Promise<void> {
    await client.query(
      `UPDATE operations.document_manifests SET checksum=$2,metadata='{}' WHERE object_key=$1`,
      [objectKey, checksum],
    );
  }


  async eraseDatabase(
    client: PoolClient,
    merchantId: string,
    customerId: string,
    retainedSubjectId: string,
  ): Promise<void> {
    const ticketIds = await client.query<{ ticket_id: string }>(
      `SELECT ticket_id FROM customers.support_participants WHERE customer_id=$1`,
      [customerId],
    );
    const paymentIds = await client.query<{ id: string }>(
      `SELECT id FROM payments.payment_intents WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId],
    );
    const ids = paymentIds.rows.map((row) => row.id);

    await client.query(
      `UPDATE customers.support_tickets SET subject='[redacted]'
       WHERE merchant_id=$1 AND id=ANY($2::uuid[])`,
      [merchantId, ticketIds.rows.map((row) => row.ticket_id)],
    );
    await client.query(
      `UPDATE customers.support_messages SET body='[redacted]',author_id=NULL,attachments='[]'
       WHERE merchant_id=$1 AND author_id=$2`,
      [merchantId, customerId],
    );
    await client.query(`DELETE FROM customers.support_participants WHERE customer_id=$1`, [customerId]);
    await client.query(`DELETE FROM customers.addresses WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
    await client.query(`DELETE FROM customers.contacts WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
    await client.query(`DELETE FROM customers.payment_method_refs WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
    await client.query(`DELETE FROM customers.provider_customer_mappings WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);

    if (ids.length) {
      await client.query(
        `UPDATE payments.payment_attempts SET request_payload='{}',response_payload='{}',failure_message=NULL
         WHERE merchant_id=$1 AND payment_intent_id=ANY($2::uuid[])`,
        [merchantId, ids],
      );
      await client.query(
        `UPDATE payments.refunds SET customer_email=NULL,reason='[redacted]'
         WHERE merchant_id=$1 AND payment_intent_id=ANY($2::uuid[])`,
        [merchantId, ids],
      );
      await client.query(
        `UPDATE payments.disputes SET evidence='{}'
         WHERE merchant_id=$1 AND payment_intent_id=ANY($2::uuid[])`,
        [merchantId, ids],
      );
      await client.query(
        `UPDATE payments.invoice_lines SET description='[redacted]'
         WHERE invoice_id IN (SELECT id FROM payments.invoices WHERE merchant_id=$1 AND customer_id=$2)`,
        [merchantId, customerId],
      );
      await client.query(
        `UPDATE payments.payment_intents SET customer_id=NULL,payment_method_id=NULL,
         retained_subject_id=$4,customer_snapshot=$3,
         description=CASE WHEN description IS NULL THEN NULL ELSE '[redacted]' END,
         updated_at=now() WHERE merchant_id=$1 AND customer_id=$2`,
        [merchantId, customerId, retainedCustomerSnapshot(), retainedSubjectId],
      );
      await client.query(
        `UPDATE payments.invoices SET customer_id=NULL,retained_subject_id=$4,billing_snapshot=$3
         WHERE merchant_id=$1 AND customer_id=$2`,
        [merchantId, customerId, retainedCustomerSnapshot(), retainedSubjectId],
      );
      await client.query(
        `UPDATE provider_sandbox.payment_intents SET payment_method_id=NULL,provider_customer_id=NULL
         WHERE merchant_id=$1 AND payment_id=ANY($2::uuid[])`,
        [merchantId, ids],
      );
      await client.query(
        `UPDATE provider_sandbox.refunds SET reason='[redacted]'
         WHERE merchant_id=$1 AND provider_payment_id IN (
           SELECT id FROM provider_sandbox.payment_intents WHERE payment_id=ANY($2::uuid[])
         )`,
        [merchantId, ids],
      );

    }
    await client.query(
      `DELETE FROM provider_sandbox.customers WHERE merchant_id=$1 AND payflow_customer_id=$2`,
      [merchantId, customerId],
    );

    await this.eraseOperationalRows(client, merchantId, customerId, ids);
    await client.query(`DELETE FROM customers.customers WHERE merchant_id=$1 AND id=$2`, [merchantId, customerId]);
  }

  private async eraseOperationalRows(
    client: PoolClient,
    merchantId: string,
    customerId: string,
    paymentIds: string[],
  ): Promise<void> {
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
    await client.query(
      `DELETE FROM operations.analytics_events WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId],
    );
    await client.query(
      `UPDATE operations.document_manifests SET customer_id=NULL,metadata='{}'
       WHERE merchant_id=$1 AND (customer_id=$2 OR metadata->>'customerId'=$2)`,
      [merchantId, customerId],
    );
    await client.query(
      `UPDATE platform.audit_logs SET target_id=NULL,metadata='{}'
       WHERE merchant_id=$1 AND (target_id=$2 OR metadata->>'customerId'=$2)`,
      [merchantId, customerId],
    );
    await client.query(
      `DELETE FROM operations.outbox_events WHERE merchant_id=$1
       AND (aggregate_id=$2 OR payload->>'customerId'=$2)`,
      [merchantId, customerId],
    );
    await client.query(
      `DELETE FROM operations.dead_letters
       WHERE payload->>'customerId'=$1 OR payload->>'customer_id'=$1
          OR payload#>>'{data,customer,id}'=$1 OR payload#>>'{data,customerId}'=$1
          OR payload#>>'{data,paymentId}'=ANY($2::text[])`,
      [customerId, paymentIds],
    );
    await client.query(
      `UPDATE operations.idempotency_keys
       SET response_body=response_body-'customerId'
       WHERE merchant_id=$1 AND response_body->>'customerId'=$2`,
      [merchantId, customerId],
    );
    await client.query(
      `UPDATE operations.jobs SET payload=(payload-'customerId'-'customerSnapshot')||'{"erased":true}'::jsonb
       WHERE merchant_id=$1 AND payload->>'customerId'=$2`,
      [merchantId, customerId],
    );

    const webhooks = await client.query<{ id: string; payload: unknown }>(
      `SELECT id,payload FROM operations.provider_webhooks
       WHERE payload#>>'{data,customer,id}'=$1
          OR payload#>>'{data,customerId}'=$1
          OR payload#>>'{data,paymentId}'=ANY($2::text[])`,
      [customerId, paymentIds],
    );
    for (const row of webhooks.rows) {
      await client.query(
        `UPDATE operations.provider_webhooks SET payload=$2 WHERE id=$1`,
        [row.id, redactPii(row.payload)],
      );
    }
  }
}
