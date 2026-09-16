import type pg from 'pg';
import { pool, transaction } from '../../../packages/database/src/pool.js';

export interface ErasureRequestRow {
  id: string;
  merchant_id: string;
  customer_id: string;
  status: 'pending' | 'processing' | 'failed' | 'completed';
  attempts: number;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

export interface ClaimedErasureRequest extends ErasureRequestRow {
  status: 'processing';
}

export interface ErasureSubject {
  emailDestinations: string[];
  documents: Array<{ objectKey: string; documentType: string }>;
}

const REQUEST_COLUMNS =
  'id,merchant_id,customer_id,status,attempts,last_error,created_at,updated_at,completed_at';

export class ErasureRepository {
  async findByCustomer(
    client: pg.PoolClient,
    merchantId: string,
    customerId: string,
  ): Promise<ErasureRequestRow | undefined> {
    const result = await client.query<ErasureRequestRow>(
      `SELECT ${REQUEST_COLUMNS} FROM privacy.erasure_requests
       WHERE merchant_id=$1 AND customer_id=$2 FOR UPDATE`,
      [merchantId, customerId],
    );
    return result.rows[0];
  }

  async findById(merchantId: string, requestId: string): Promise<ErasureRequestRow | undefined> {
    const result = await pool.query<ErasureRequestRow>(
      `SELECT ${REQUEST_COLUMNS} FROM privacy.erasure_requests WHERE merchant_id=$1 AND id=$2`,
      [merchantId, requestId],
    );
    return result.rows[0];
  }

  async customerExists(client: pg.PoolClient, merchantId: string, customerId: string): Promise<boolean> {
    const result = await client.query(
      `SELECT 1 FROM customers.customers WHERE merchant_id=$1 AND id=$2`,
      [merchantId, customerId],
    );
    return Boolean(result.rowCount);
  }

  /** Accepts a request and immediately suppresses further writes of the customer's personal data. */
  async create(client: pg.PoolClient, merchantId: string, customerId: string): Promise<ErasureRequestRow> {
    const created = await client.query<ErasureRequestRow>(
      `INSERT INTO privacy.erasure_requests(merchant_id,customer_id) VALUES($1,$2)
       RETURNING ${REQUEST_COLUMNS}`,
      [merchantId, customerId],
    );
    const request = created.rows[0]!;
    await client.query(
      `INSERT INTO privacy.erased_customers(merchant_id,customer_id,request_id) VALUES($1,$2,$3)
       ON CONFLICT(merchant_id,customer_id) DO NOTHING`,
      [merchantId, customerId, request.id],
    );
    return request;
  }

  /** Makes a previously failed request runnable again without repeating finished work. */
  async requeue(client: pg.PoolClient, requestId: string): Promise<void> {
    await client.query(
      `UPDATE privacy.erasure_requests SET status='pending',available_at=now(),updated_at=now()
       WHERE id=$1 AND status='failed'`,
      [requestId],
    );
  }

  async recoverExpiredLeases(): Promise<number> {
    const result = await pool.query(
      `UPDATE privacy.erasure_requests
       SET status='failed',available_at=now(),locked_by=NULL,locked_at=NULL,lease_expires_at=NULL,
           last_error=COALESCE(last_error,'erasure_lease_expired'),updated_at=now()
       WHERE status='processing' AND lease_expires_at<now()`,
    );
    return result.rowCount ?? 0;
  }

  async claim(workerId: string, leaseSeconds = 60): Promise<ClaimedErasureRequest | undefined> {
    const result = await pool.query<ClaimedErasureRequest>(
      `UPDATE privacy.erasure_requests
       SET status='processing',attempts=attempts+1,locked_by=$1,locked_at=now(),
           lease_expires_at=now()+($2 || ' seconds')::interval,last_error=NULL,updated_at=now()
       WHERE id=(SELECT id FROM privacy.erasure_requests
         WHERE status IN ('pending','failed') AND available_at<=now()
         ORDER BY available_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1)
       RETURNING ${REQUEST_COLUMNS}`,
      [workerId, leaseSeconds],
    );
    return result.rows[0];
  }

  async completedSteps(requestId: string): Promise<Set<string>> {
    const result = await pool.query<{ step: string }>(
      `SELECT step FROM privacy.erasure_request_steps WHERE request_id=$1`,
      [requestId],
    );
    return new Set(result.rows.map((row) => row.step));
  }

  async markStepCompleted(requestId: string, step: string, client?: pg.PoolClient): Promise<void> {
    const executor = client ?? pool;
    await executor.query(
      `INSERT INTO privacy.erasure_request_steps(request_id,step) VALUES($1,$2)
       ON CONFLICT(request_id,step) DO NOTHING`,
      [requestId, step],
    );
  }

  async markFailed(requestId: string, errorCode: string, retryDelaySeconds: number): Promise<void> {
    await pool.query(
      `UPDATE privacy.erasure_requests
       SET status='failed',last_error=$2,available_at=now()+($3 || ' seconds')::interval,
           locked_by=NULL,locked_at=NULL,lease_expires_at=NULL,updated_at=now()
       WHERE id=$1`,
      [requestId, errorCode, retryDelaySeconds],
    );
  }

  /** Collects the addresses and stored documents that still expose the customer. */
  async describeSubject(merchantId: string, customerId: string): Promise<ErasureSubject> {
    const destinations = await pool.query<{ destination: string }>(
      `SELECT email destination FROM customers.customers WHERE merchant_id=$1 AND id=$2
       UNION
       SELECT value FROM customers.contacts WHERE merchant_id=$1 AND customer_id=$2 AND kind='email'
       UNION
       SELECT destination FROM operations.notification_preferences WHERE merchant_id=$1 AND customer_id=$2
       UNION
       SELECT destination FROM operations.email_deliveries WHERE merchant_id=$1 AND customer_id=$2
       UNION
       SELECT destination FROM operations.notifications WHERE merchant_id=$1 AND customer_id=$2`,
      [merchantId, customerId],
    );
    const documents = await pool.query<{ object_key: string; document_type: string }>(
      `SELECT object_key,document_type FROM operations.document_manifests
       WHERE merchant_id=$1 AND (customer_id=$2 OR document_type='customer_import')`,
      [merchantId, customerId],
    );
    return {
      emailDestinations: destinations.rows.map((row) => row.destination).filter((value) => Boolean(value)),
      documents: documents.rows.map((row) => ({ objectKey: row.object_key, documentType: row.document_type })),
    };
  }

  async updateDocumentChecksum(objectKey: string, checksum: string): Promise<void> {
    await pool.query(
      `UPDATE operations.document_manifests SET checksum=$2,metadata=privacy.redact_pii(metadata)
       WHERE object_key=$1`,
      [objectKey, checksum],
    );
  }

  /**
   * Removes the customer's personal data from the database and marks the request
   * complete in one transaction, so a completed request always means the data is
   * gone. Retained financial records keep their amounts and identifiers.
   */
  async purgeDatabase(request: ErasureRequestRow): Promise<void> {
    const scope = [request.merchant_id, request.customer_id];
    await transaction(async (client) => {
      await client.query(
        `UPDATE payments.payment_intents
         SET customer_snapshot=privacy.redact_pii(customer_snapshot),updated_at=now()
         WHERE merchant_id=$1 AND customer_id=$2`, scope,
      );
      await client.query(
        `UPDATE payments.payment_attempts a
         SET request_payload=privacy.redact_pii(a.request_payload),
             response_payload=privacy.redact_pii(a.response_payload)
         FROM payments.payment_intents p
         WHERE p.id=a.payment_intent_id AND p.merchant_id=$1 AND p.customer_id=$2`, scope,
      );
      await client.query(
        `UPDATE payments.refunds r SET customer_email=NULL
         FROM payments.payment_intents p
         WHERE p.id=r.payment_intent_id AND p.merchant_id=$1 AND p.customer_id=$2`, scope,
      );
      await client.query(
        `UPDATE payments.disputes d SET evidence=privacy.redact_pii(d.evidence)
         FROM payments.payment_intents p
         WHERE p.id=d.payment_intent_id AND p.merchant_id=$1 AND p.customer_id=$2`, scope,
      );
      await client.query(
        `UPDATE payments.invoices SET billing_snapshot=privacy.redact_pii(billing_snapshot)
         WHERE merchant_id=$1 AND customer_id=$2`, scope,
      );

      await client.query(
        `UPDATE operations.outbox_events SET payload=privacy.redact_pii(payload)
         WHERE merchant_id=$1 AND (aggregate_id=$2 OR payload->>'customerId'=$2::text)`, scope,
      );
      await client.query(
        `UPDATE operations.analytics_events SET email=NULL,properties=privacy.redact_pii(properties),
           anonymous_id=NULL
         WHERE merchant_id=$1 AND (customer_id=$2 OR properties->>'customerId'=$2::text)`, scope,
      );
      await client.query(
        `UPDATE operations.jobs SET payload=privacy.redact_pii(payload)
         WHERE merchant_id=$1 AND payload->>'customerId'=$2::text`, scope,
      );
      await client.query(
        `UPDATE operations.idempotency_keys SET response_body=privacy.redact_pii(response_body)
         WHERE merchant_id=$1 AND response_body->>'customerId'=$2::text`, scope,
      );
      await client.query(
        `UPDATE operations.dead_letters SET payload=privacy.redact_pii(payload)
         WHERE payload->>'customerId'=$2::text AND payload->>'merchantId'=$1::text`, scope,
      );
      await client.query(
        `UPDATE operations.document_manifests SET metadata=privacy.redact_pii(metadata)
         WHERE merchant_id=$1 AND customer_id=$2`, scope,
      );
      await client.query(
        `DELETE FROM operations.notifications WHERE merchant_id=$1 AND customer_id=$2`, scope,
      );
      await client.query(
        `DELETE FROM operations.email_deliveries WHERE merchant_id=$1 AND customer_id=$2`, scope,
      );
      await client.query(
        `DELETE FROM operations.notification_preferences WHERE merchant_id=$1 AND customer_id=$2`, scope,
      );

      await client.query(
        `UPDATE platform.audit_logs SET metadata=privacy.redact_pii(metadata)
         WHERE merchant_id=$1 AND target_type='customer' AND target_id=$2::text`, scope,
      );

      await client.query(
        `DELETE FROM provider_sandbox.customers WHERE merchant_id=$1 AND payflow_customer_id=$2`, scope,
      );

      await client.query(
        `DELETE FROM customers.support_messages
         WHERE merchant_id=$1 AND author_type='customer' AND author_id=$2`, scope,
      );
      await client.query(
        `DELETE FROM customers.support_participants p
         USING customers.support_tickets t
         WHERE t.id=p.ticket_id AND t.merchant_id=$1 AND p.customer_id=$2`, scope,
      );
      await client.query(
        `DELETE FROM customers.support_messages
         WHERE ticket_id IN (
           SELECT t.id FROM customers.support_tickets t
           WHERE t.merchant_id=$1
             AND NOT EXISTS(SELECT 1 FROM customers.support_participants p WHERE p.ticket_id=t.id)
         )`, [request.merchant_id],
      );
      await client.query(
        `DELETE FROM customers.support_tickets t
         WHERE t.merchant_id=$1
           AND NOT EXISTS(SELECT 1 FROM customers.support_participants p WHERE p.ticket_id=t.id)
           AND NOT EXISTS(SELECT 1 FROM customers.support_messages m WHERE m.ticket_id=t.id)`,
        [request.merchant_id],
      );
      await client.query(`DELETE FROM customers.addresses WHERE merchant_id=$1 AND customer_id=$2`, scope);
      await client.query(`DELETE FROM customers.contacts WHERE merchant_id=$1 AND customer_id=$2`, scope);
      await client.query(
        `DELETE FROM customers.payment_method_refs WHERE merchant_id=$1 AND customer_id=$2`, scope,
      );
      await client.query(
        `DELETE FROM customers.provider_customer_mappings WHERE merchant_id=$1 AND customer_id=$2`, scope,
      );
      await client.query(`DELETE FROM customers.customers WHERE merchant_id=$1 AND id=$2`, scope);

      await client.query(
        `UPDATE privacy.erased_customers SET erased_at=now() WHERE merchant_id=$1 AND customer_id=$2`, scope,
      );
      await this.markStepCompleted(request.id, 'database', client);
      await client.query(
        `UPDATE privacy.erasure_requests
         SET status='completed',completed_at=now(),last_error=NULL,
             locked_by=NULL,locked_at=NULL,lease_expires_at=NULL,updated_at=now()
         WHERE id=$1`,
        [request.id],
      );
      await client.query(
        `INSERT INTO platform.audit_logs
         (merchant_id,actor_type,target_type,target_id,action,metadata,correlation_id)
         VALUES($1,'service','erasure_request',$2,'privacy.erasure.completed',$3,gen_random_uuid())`,
        [request.merchant_id, request.id, { customerId: request.customer_id, attempts: request.attempts }],
      );
    });
  }

  async recordRequestedAudit(
    client: pg.PoolClient,
    request: ErasureRequestRow,
    correlationId: string,
  ): Promise<void> {
    await client.query(
      `INSERT INTO platform.audit_logs
       (merchant_id,actor_type,target_type,target_id,action,metadata,correlation_id)
       VALUES($1,'api_key','erasure_request',$2,'privacy.erasure.requested',$3,$4)`,
      [request.merchant_id, request.id, { customerId: request.customer_id }, correlationId],
    );
  }
}
