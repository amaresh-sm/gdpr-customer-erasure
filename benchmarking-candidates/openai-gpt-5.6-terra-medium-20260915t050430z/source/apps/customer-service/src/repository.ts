import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { EVENT_TYPES } from '../../../packages/contracts/src/events.js';
import { pool } from '../../../packages/database/src/pool.js';
import { addOutboxEvent } from '../../../packages/messaging/src/outbox.js';
import type { CreateCustomer } from '../../../packages/contracts/src/domain.js';

export interface CustomerRow {
  id: string; merchant_id: string; external_reference: string; email: string; name: string;
  phone: string | null; status: string; metadata: Record<string, string>; version: number;
  created_at: Date; updated_at: Date;
}

export interface ProviderCustomerMapping {
  provider_customer_id: string;
}

export interface AddressInput {
  kind: string;
  line1: string;
  line2?: string | undefined;
  city: string;
  region?: string | undefined;
  postalCode: string;
  country: string;
}

export interface ContactInput {
  kind: string;
  value: string;
  isPrimary: boolean;
}

export interface PaymentMethodInput {
  providerToken: string;
  type: string;
  brand?: string | undefined;
  last4?: string | undefined;
  billingName?: string | undefined;
  billingAddress?: Record<string, unknown> | undefined;
}

export class CustomerRepository {
  async create(client: pg.PoolClient, merchantId: string, input: CreateCustomer): Promise<CustomerRow> {
    const result = await client.query<CustomerRow>(
      `INSERT INTO customers.customers(merchant_id,external_reference,email,name,phone,metadata)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
      [merchantId, input.externalReference, input.email, input.name, input.phone ?? null, input.metadata],
    );
    return result.rows[0]!;
  }

  async find(merchantId: string, customerId: string): Promise<CustomerRow | undefined> {
    const result = await pool.query<CustomerRow>(
      `SELECT * FROM customers.customers WHERE merchant_id=$1 AND id=$2 AND status='active'`, [merchantId, customerId],
    );
    return result.rows[0];
  }

  async list(merchantId: string, cursor: string | undefined, limit: number): Promise<CustomerRow[]> {
    const result = await pool.query<CustomerRow>(
      `SELECT * FROM customers.customers WHERE merchant_id=$1 AND status='active' AND ($2::uuid IS NULL OR id>$2)
       ORDER BY id LIMIT $3`, [merchantId, cursor ?? null, limit],
    );
    return result.rows;
  }

  async findPaymentMethod(merchantId: string, customerId: string, paymentMethodId: string): Promise<Record<string, unknown> | undefined> {
    const result = await pool.query(
      `SELECT id,customer_id,type,brand,last4,billing_name,billing_address,status
       FROM customers.payment_method_refs WHERE merchant_id=$1 AND customer_id=$2 AND id=$3`,
      [merchantId, customerId, paymentMethodId],
    );
    return result.rows[0] as Record<string, unknown> | undefined;
  }

  async findPaymentMethodForProvider(merchantId: string, customerId: string, paymentMethodId: string): Promise<Record<string, unknown> | undefined> {
    const result = await pool.query(
      `SELECT id,customer_id,provider_token,status FROM customers.payment_method_refs
       WHERE merchant_id=$1 AND customer_id=$2 AND id=$3`,
      [merchantId, customerId, paymentMethodId],
    );
    return result.rows[0] as Record<string, unknown> | undefined;
  }

  /** Returns the stable provider-side customer identifier used for future payment operations. */
  async ensureProviderCustomer(
    client: pg.PoolClient,
    merchantId: string,
    customerId: string,
    providerName: string,
    providerCustomerId: string,
  ): Promise<ProviderCustomerMapping | undefined> {
    const existing = await client.query<ProviderCustomerMapping>(
      `SELECT provider_customer_id FROM customers.provider_customer_mappings
       WHERE merchant_id=$1 AND customer_id=$2 AND provider_name=$3 FOR UPDATE`,
      [merchantId, customerId, providerName],
    );
    if (existing.rows[0]) {
      await client.query(
        `UPDATE customers.provider_customer_mappings SET last_seen_at=now()
         WHERE merchant_id=$1 AND customer_id=$2 AND provider_name=$3`,
        [merchantId, customerId, providerName],
      );
      return existing.rows[0];
    }
    const created = await client.query<ProviderCustomerMapping>(
      `INSERT INTO customers.provider_customer_mappings
       (merchant_id,customer_id,provider_name,provider_customer_id)
       SELECT $1,id,$3,$4 FROM customers.customers WHERE merchant_id=$1 AND id=$2 AND status='active'
       ON CONFLICT(merchant_id,customer_id,provider_name)
       DO UPDATE SET last_seen_at=now()
       RETURNING provider_customer_id`,
      [merchantId, customerId, providerName, providerCustomerId],
    );
    return created.rows[0];
  }

  async update(client: pg.PoolClient, merchantId: string, customerId: string,
               version: number, fields: { email?: string | undefined; name?: string | undefined; phone?: string | null | undefined }): Promise<CustomerRow | undefined> {
    const result = await client.query<CustomerRow>(
      `UPDATE customers.customers SET email=COALESCE($4,email),name=COALESCE($5,name),phone=COALESCE($6,phone),
       version=version+1,updated_at=now() WHERE merchant_id=$1 AND id=$2 AND status='active' AND version=$3 RETURNING *`,
      [merchantId, customerId, version, fields.email ?? null, fields.name ?? null, fields.phone ?? null],
    );
    return result.rows[0];
  }

  async addAddress(client: pg.PoolClient, merchantId: string, customerId: string, input: AddressInput): Promise<string | undefined> {
    const result = await client.query<{ id: string }>(
      `INSERT INTO customers.addresses(merchant_id,customer_id,kind,line1,line2,city,region,postal_code,country)
       SELECT $1,id,$3,$4,$5,$6,$7,$8,$9 FROM customers.customers
       WHERE merchant_id=$1 AND id=$2 AND status='active' RETURNING id`,
      [
        merchantId,
        customerId,
        input.kind,
        input.line1,
        input.line2 ?? null,
        input.city,
        input.region ?? null,
        input.postalCode,
        input.country,
      ],
    );
    return result.rows[0]?.id;
  }

  async addContact(client: pg.PoolClient, merchantId: string, customerId: string, input: ContactInput): Promise<string | undefined> {
    const result = await client.query<{ id: string }>(
      `INSERT INTO customers.contacts(merchant_id,customer_id,kind,value,is_primary)
       SELECT $1,id,$3,$4,$5 FROM customers.customers WHERE merchant_id=$1 AND id=$2 AND status='active' RETURNING id`,
      [merchantId, customerId, input.kind, input.value, input.isPrimary],
    );
    return result.rows[0]?.id;
  }

  async attachPaymentMethod(
    client: pg.PoolClient,
    merchantId: string,
    customerId: string,
    input: PaymentMethodInput,
  ): Promise<string | undefined> {
    const result = await client.query<{ id: string }>(
      `INSERT INTO customers.payment_method_refs
       (merchant_id,customer_id,provider_token,type,brand,last4,billing_name,billing_address)
       SELECT $1,id,$3,$4,$5,$6,$7,$8 FROM customers.customers
       WHERE merchant_id=$1 AND id=$2 AND status='active' RETURNING id`,
      [
        merchantId,
        customerId,
        input.providerToken,
        input.type,
        input.brand ?? null,
        input.last4 ?? null,
        input.billingName ?? null,
        input.billingAddress ?? null,
      ],
    );
    return result.rows[0]?.id;
  }

  async createSupportTicket(
    client: pg.PoolClient,
    merchantId: string,
    customerId: string,
    subject: string,
    body: string,
  ): Promise<{ ticketId: string; messageId: string } | undefined> {
    const exists = await client.query(
      `SELECT 1 FROM customers.customers WHERE merchant_id=$1 AND id=$2 AND status='active'`,
      [merchantId, customerId],
    );
    if (!exists.rowCount) return undefined;
    const ticket = await client.query<{ id: string }>(
      `INSERT INTO customers.support_tickets(merchant_id,subject) VALUES($1,$2) RETURNING id`,
      [merchantId, subject],
    );
    const ticketId = ticket.rows[0]!.id;
    await client.query(
      `INSERT INTO customers.support_participants(ticket_id,customer_id) VALUES($1,$2)`,
      [ticketId, customerId],
    );
    const message = await client.query<{ id: string }>(
      `INSERT INTO customers.support_messages(merchant_id,ticket_id,author_type,author_id,body)
       VALUES($1,$2,'customer',$3,$4) RETURNING id`,
      [merchantId, ticketId, customerId, body],
    );
    return { ticketId, messageId: message.rows[0]!.id };
  }

  async recordImport(
    client: pg.PoolClient,
    input: { importId: string; merchantId: string; source: string; objectKey: string; content: string },
  ): Promise<void> {
    await client.query(
      `INSERT INTO customers.customer_imports(id,merchant_id,source,object_key,status,rows_total,rows_succeeded)
       VALUES($1,$2,$3,$4,'completed',1,1)`,
      [input.importId, input.merchantId, input.source, input.objectKey],
    );
    await client.query(
      `INSERT INTO operations.document_manifests(merchant_id,object_key,document_type,content_type,checksum,metadata)
       VALUES($1,$2,'customer_import','application/json',encode(digest($3,'sha256'),'hex'),$4)`,
      [input.merchantId, input.objectKey, input.content, { importId: input.importId, source: input.source }],
    );
  }

  async createErasureRequest(
    client: pg.PoolClient,
    merchantId: string,
    customerId: string,
    idempotencyKey: string,
  ): Promise<ErasureRequest | undefined> {
    const keyMatch = await client.query<ErasureRequest>(
      `SELECT * FROM customers.erasure_requests WHERE merchant_id=$1 AND idempotency_key=$2 FOR UPDATE`,
      [merchantId, idempotencyKey],
    );
    if (keyMatch.rows[0]) {
      if (keyMatch.rows[0].customer_id !== customerId) throw Object.assign(new Error('idempotency_key_reused'), { statusCode: 409 });
      if (keyMatch.rows[0].status !== 'failed') return keyMatch.rows[0];
      const resumed = await client.query<ErasureRequest>(
        `UPDATE customers.erasure_requests SET status='pending',updated_at=now(),last_error=NULL WHERE id=$1 RETURNING *`,
        [keyMatch.rows[0].id],
      );
      return resumed.rows[0];
    }
    const customer = await client.query(
      `SELECT id FROM customers.customers WHERE merchant_id=$1 AND id=$2 FOR UPDATE`,
      [merchantId, customerId],
    );
    if (!customer.rowCount) return undefined;
    const request = await client.query<ErasureRequest>(
      `INSERT INTO customers.erasure_requests(merchant_id,customer_id,idempotency_key,status)
       VALUES($1,$2,$3,'pending')
       ON CONFLICT(merchant_id,customer_id) DO UPDATE SET
         status=CASE WHEN customers.erasure_requests.status='failed' THEN 'pending' ELSE customers.erasure_requests.status END,
         last_error=CASE WHEN customers.erasure_requests.status='failed' THEN NULL ELSE customers.erasure_requests.last_error END,
         updated_at=CASE WHEN customers.erasure_requests.status='failed' THEN now() ELSE customers.erasure_requests.updated_at END
       RETURNING *`,
      [merchantId, customerId, idempotencyKey],
    );
    await client.query(`UPDATE customers.customers SET status='erasing',updated_at=now() WHERE merchant_id=$1 AND id=$2`, [merchantId, customerId]);
    return request.rows[0];
  }

  async findErasureRequest(merchantId: string, requestId: string): Promise<ErasureRequest | undefined> {
    const result = await pool.query<ErasureRequest>(
      `SELECT * FROM customers.erasure_requests WHERE merchant_id=$1 AND id=$2`, [merchantId, requestId],
    );
    return result.rows[0];
  }

  async claimErasureRequest(client: pg.PoolClient): Promise<ErasureRequest | undefined> {
    const result = await client.query<ErasureRequest>(
      `UPDATE customers.erasure_requests SET status='processing',attempts=attempts+1,updated_at=now(),last_error=NULL
       WHERE id=(SELECT id FROM customers.erasure_requests
         WHERE status='pending' OR (status='failed' AND updated_at<=now()-interval '30 seconds')
         ORDER BY updated_at FOR UPDATE SKIP LOCKED LIMIT 1)
       RETURNING *`,
    );
    return result.rows[0];
  }

  async objectKeysForErasure(merchantId: string, customerId: string): Promise<string[]> {
    const result = await pool.query<{ object_key: string }>(
      `SELECT object_key FROM operations.document_manifests WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId],
    );
    return result.rows.map((row) => row.object_key);
  }

  async erasePersonalData(client: pg.PoolClient, request: ErasureRequest): Promise<void> {
    const { merchant_id: merchantId, customer_id: customerId, id } = request;
    await client.query(`DELETE FROM operations.email_deliveries WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
    await client.query(`DELETE FROM operations.notifications WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
    await client.query(`DELETE FROM operations.notification_preferences WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
    await client.query(`DELETE FROM operations.analytics_events WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
    await client.query(`DELETE FROM operations.document_manifests WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
    await client.query(`DELETE FROM operations.jobs WHERE merchant_id=$1 AND payload->>'customerId'=$2`, [merchantId, customerId]);
    await client.query(`DELETE FROM operations.outbox_events WHERE merchant_id=$1 AND (aggregate_id=$2::uuid OR payload->>'customerId'=$2)`, [merchantId, customerId]);
    await client.query(`DELETE FROM platform.audit_logs WHERE merchant_id=$1 AND target_type='customer' AND target_id=$2`, [merchantId, customerId]);
    await client.query(`UPDATE payments.payment_attempts SET request_payload='{}',response_payload=NULL,failure_message=NULL
      WHERE merchant_id=$1 AND payment_intent_id IN (SELECT id FROM payments.payment_intents WHERE merchant_id=$1 AND customer_id=$2)`, [merchantId, customerId]);
    await client.query(`UPDATE payments.refunds SET customer_email=NULL WHERE merchant_id=$1 AND payment_intent_id IN
      (SELECT id FROM payments.payment_intents WHERE merchant_id=$1 AND customer_id=$2)`, [merchantId, customerId]);
    await client.query(`UPDATE payments.disputes SET evidence='{}' WHERE merchant_id=$1 AND payment_intent_id IN
      (SELECT id FROM payments.payment_intents WHERE merchant_id=$1 AND customer_id=$2)`, [merchantId, customerId]);
    await client.query(`UPDATE payments.payment_intents SET customer_id=NULL,payment_method_id=NULL,customer_snapshot='{}',updated_at=now()
      WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
    await client.query(`UPDATE payments.invoices SET customer_id=NULL,billing_snapshot='{}' WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
    await client.query(`UPDATE provider_sandbox.payment_intents SET provider_customer_id=NULL WHERE merchant_id=$1 AND provider_customer_id IN
      (SELECT provider_customer_id FROM customers.provider_customer_mappings WHERE merchant_id=$1 AND customer_id=$2)`, [merchantId, customerId]);
    await client.query(`DELETE FROM provider_sandbox.customers WHERE merchant_id=$1 AND payflow_customer_id=$2`, [merchantId, customerId]);
    await client.query(`DELETE FROM customers.support_messages WHERE merchant_id=$1 AND author_id=$2`, [merchantId, customerId]);
    await client.query(`DELETE FROM customers.support_participants WHERE customer_id=$1`, [customerId]);
    await client.query(`DELETE FROM customers.provider_customer_mappings WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
    await client.query(`DELETE FROM customers.payment_method_refs WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
    await client.query(`DELETE FROM customers.contacts WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
    await client.query(`DELETE FROM customers.addresses WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
    await client.query(`DELETE FROM customers.customers WHERE merchant_id=$1 AND id=$2`, [merchantId, customerId]);
    await addOutboxEvent(client, {
      eventType: EVENT_TYPES.CUSTOMER_ERASED, aggregateType: 'customer', aggregateId: customerId,
      merchantId, correlationId: randomUUID(), payload: { customerId, erasureRequestId: id },
    });
    await client.query(`UPDATE customers.erasure_requests SET status='completed',completed_at=now(),updated_at=now(),last_error=NULL WHERE id=$1`, [id]);
  }

  async failErasureRequest(requestId: string): Promise<void> {
    await pool.query(`UPDATE customers.erasure_requests SET status='failed',last_error='erasure_cleanup_failed',updated_at=now() WHERE id=$1`, [requestId]);
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

export interface ErasureRequest {
  id: string;
  merchant_id: string;
  customer_id: string;
  idempotency_key: string;
  status: 'pending' | 'processing' | 'failed' | 'completed';
  attempts: number;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}
