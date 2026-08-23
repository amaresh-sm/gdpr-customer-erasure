import type pg from 'pg';
import { pool } from '../../../packages/database/src/pool.js';
import type { CreateCustomer } from '../../../packages/contracts/src/domain.js';

export interface CustomerRow {
  id: string; merchant_id: string; external_reference: string; email: string; name: string;
  phone: string | null; status: string; metadata: Record<string, string>; version: number;
  created_at: Date; updated_at: Date;
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
      `SELECT * FROM customers.customers WHERE merchant_id=$1 AND id=$2`, [merchantId, customerId],
    );
    return result.rows[0];
  }

  async list(merchantId: string, cursor: string | undefined, limit: number): Promise<CustomerRow[]> {
    const result = await pool.query<CustomerRow>(
      `SELECT * FROM customers.customers WHERE merchant_id=$1 AND ($2::uuid IS NULL OR id>$2)
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

  async update(client: pg.PoolClient, merchantId: string, customerId: string,
               version: number, fields: { email?: string | undefined; name?: string | undefined; phone?: string | null | undefined }): Promise<CustomerRow | undefined> {
    const result = await client.query<CustomerRow>(
      `UPDATE customers.customers SET email=COALESCE($4,email),name=COALESCE($5,name),phone=COALESCE($6,phone),
       version=version+1,updated_at=now() WHERE merchant_id=$1 AND id=$2 AND version=$3 RETURNING *`,
      [merchantId, customerId, version, fields.email ?? null, fields.name ?? null, fields.phone ?? null],
    );
    return result.rows[0];
  }

  async addAddress(client: pg.PoolClient, merchantId: string, customerId: string, input: AddressInput): Promise<string | undefined> {
    const result = await client.query<{ id: string }>(
      `INSERT INTO customers.addresses(merchant_id,customer_id,kind,line1,line2,city,region,postal_code,country)
       SELECT $1,id,$3,$4,$5,$6,$7,$8,$9 FROM customers.customers
       WHERE merchant_id=$1 AND id=$2 RETURNING id`,
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
       SELECT $1,id,$3,$4,$5 FROM customers.customers WHERE merchant_id=$1 AND id=$2 RETURNING id`,
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
       WHERE merchant_id=$1 AND id=$2 RETURNING id`,
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
      `SELECT 1 FROM customers.customers WHERE merchant_id=$1 AND id=$2`,
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
