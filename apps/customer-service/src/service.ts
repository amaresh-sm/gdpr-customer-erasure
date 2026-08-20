import { v4 as uuid } from 'uuid';
import type pg from 'pg';
import { EVENT_TYPES } from '../../../packages/contracts/src/events.js';
import type { CreateCustomer } from '../../../packages/contracts/src/domain.js';
import { transaction } from '../../../packages/database/src/pool.js';
import { addOutboxEvent } from '../../../packages/messaging/src/outbox.js';
import { DOCUMENT_BUCKET, ensureBucket, objectStore } from '../../../packages/storage/src/minio.js';
import { CustomerRepository, type CustomerRow } from './repository.js';

export class CustomerService {
  constructor(private readonly repository = new CustomerRepository()) {}

  async create(merchantId: string, input: CreateCustomer, correlationId = uuid()): Promise<CustomerRow> {
    return transaction(async (client) => {
      const customer = await this.repository.create(client, merchantId, input);
      await this.audit(client, merchantId, customer.id, 'customer.created', correlationId, { email: input.email });
      await addOutboxEvent(client, { eventType: EVENT_TYPES.CUSTOMER_CREATED, aggregateType: 'customer',
        aggregateId: customer.id, merchantId, correlationId, payload: this.eventPayload(customer) });
      return customer;
    });
  }

  async update(merchantId: string, customerId: string, version: number,
               fields: { email?: string | undefined; name?: string | undefined; phone?: string | null | undefined }, correlationId = uuid()): Promise<CustomerRow> {
    return transaction(async (client) => {
      const customer = await this.repository.update(client, merchantId, customerId, version, fields);
      if (!customer) throw Object.assign(new Error('customer not found or version conflict'), { statusCode: 409 });
      await this.audit(client, merchantId, customerId, 'customer.updated', correlationId, { fields: Object.keys(fields) });
      await addOutboxEvent(client, { eventType: EVENT_TYPES.CUSTOMER_UPDATED, aggregateType: 'customer',
        aggregateId: customer.id, merchantId, correlationId, payload: this.eventPayload(customer) });
      return customer;
    });
  }

  async addAddress(client: pg.PoolClient, merchantId: string, customerId: string, input: {
    kind: string; line1: string; line2?: string | undefined; city: string; region?: string | undefined;
    postalCode: string; country: string;
  }): Promise<string> {
    const result = await client.query<{ id: string }>(
      `INSERT INTO customers.addresses(merchant_id,customer_id,kind,line1,line2,city,region,postal_code,country)
       SELECT $1,id,$3,$4,$5,$6,$7,$8,$9 FROM customers.customers WHERE merchant_id=$1 AND id=$2 RETURNING id`,
      [merchantId, customerId, input.kind, input.line1, input.line2 ?? null, input.city, input.region ?? null,
       input.postalCode, input.country],
    );
    if (!result.rows[0]) throw Object.assign(new Error('customer not found'), { statusCode: 404 });
    const addressId = result.rows[0].id;
    const correlationId = uuid();
    await this.audit(client, merchantId, customerId, 'customer.address.created', correlationId, { addressId, ...input });
    await addOutboxEvent(client, { eventType: EVENT_TYPES.CUSTOMER_ADDRESS_CHANGED, aggregateType: 'customer',
      aggregateId: customerId, merchantId, correlationId, payload: { customerId, addressId, ...input } });
    return addressId;
  }

  async addContact(client: pg.PoolClient, merchantId: string, customerId: string,
                   input: { kind: string; value: string; isPrimary: boolean }): Promise<string> {
    const result = await client.query<{ id: string }>(
      `INSERT INTO customers.contacts(merchant_id,customer_id,kind,value,is_primary)
       SELECT $1,id,$3,$4,$5 FROM customers.customers WHERE merchant_id=$1 AND id=$2 RETURNING id`,
      [merchantId, customerId, input.kind, input.value, input.isPrimary],
    );
    if (!result.rows[0]) throw Object.assign(new Error('customer not found'), { statusCode: 404 });
    const contactId = result.rows[0].id;
    const correlationId = uuid();
    await this.audit(client, merchantId, customerId, 'customer.contact.created', correlationId, { contactId, ...input });
    await addOutboxEvent(client, { eventType: EVENT_TYPES.CUSTOMER_CONTACT_CHANGED, aggregateType: 'customer',
      aggregateId: customerId, merchantId, correlationId, payload: { customerId, contactId, ...input } });
    return contactId;
  }

  async attachPaymentMethod(client: pg.PoolClient, merchantId: string, customerId: string,
                            input: { providerToken: string; type: string; brand?: string | undefined; last4?: string | undefined;
                              billingName?: string | undefined; billingAddress?: Record<string, unknown> | undefined }): Promise<string> {
    const result = await client.query<{ id: string }>(
      `INSERT INTO customers.payment_method_refs
       (merchant_id,customer_id,provider_token,type,brand,last4,billing_name,billing_address)
       SELECT $1,id,$3,$4,$5,$6,$7,$8 FROM customers.customers WHERE merchant_id=$1 AND id=$2 RETURNING id`,
      [merchantId, customerId, input.providerToken, input.type, input.brand ?? null, input.last4 ?? null,
        input.billingName ?? null, input.billingAddress ?? null],
    );
    if (!result.rows[0]) throw Object.assign(new Error('customer not found'), { statusCode: 404 });
    const paymentMethodId = result.rows[0].id;
    const correlationId = uuid();
    await this.audit(client, merchantId, customerId, 'payment_method.attached', correlationId,
      { paymentMethodId, type: input.type, last4: input.last4 });
    await addOutboxEvent(client, { eventType: EVENT_TYPES.PAYMENT_METHOD_ATTACHED, aggregateType: 'customer',
      aggregateId: customerId, merchantId, correlationId, payload: { customerId, paymentMethodId,
        type: input.type, brand: input.brand, last4: input.last4, billingName: input.billingName } });
    return paymentMethodId;
  }

  async createSupportTicket(client: pg.PoolClient, merchantId: string, customerId: string,
                            subject: string, body: string): Promise<string> {
    const exists = await client.query(`SELECT 1 FROM customers.customers WHERE merchant_id=$1 AND id=$2`, [merchantId, customerId]);
    if (!exists.rowCount) throw Object.assign(new Error('customer not found'), { statusCode: 404 });
    const ticket = await client.query<{ id: string }>(
      `INSERT INTO customers.support_tickets(merchant_id,subject) VALUES($1,$2) RETURNING id`, [merchantId, subject],
    );
    const ticketId = ticket.rows[0]!.id;
    await client.query(`INSERT INTO customers.support_participants(ticket_id,customer_id) VALUES($1,$2)`, [ticketId, customerId]);
    const message = await client.query<{ id: string }>(
      `INSERT INTO customers.support_messages(merchant_id,ticket_id,author_type,author_id,body)
       VALUES($1,$2,'customer',$3,$4) RETURNING id`, [merchantId, ticketId, customerId, body],
    );
    await addOutboxEvent(client, { eventType: EVENT_TYPES.SUPPORT_MESSAGE_CREATED, aggregateType: 'customer',
      aggregateId: customerId, merchantId, correlationId: uuid(), payload: { customerId, ticketId,
        messageId: message.rows[0]!.id, subject, body } });
    return ticketId;
  }

  async importCustomerArtifact(merchantId: string, source: string, content: string): Promise<string> {
    await ensureBucket();
    const importId = uuid();
    const objectKey = `${merchantId}/imports/${importId}.json`;
    await objectStore.putObject(DOCUMENT_BUCKET, objectKey, content, Buffer.byteLength(content), { 'Content-Type': 'application/json' });
    await transaction(async (client) => {
      await client.query(
        `INSERT INTO customers.customer_imports(id,merchant_id,source,object_key,status,rows_total,rows_succeeded)
         VALUES($1,$2,$3,$4,'completed',1,1)`, [importId, merchantId, source, objectKey],
      );
      await client.query(
        `INSERT INTO operations.document_manifests(merchant_id,object_key,document_type,content_type,checksum,metadata)
         VALUES($1,$2,'customer_import','application/json',encode(digest($3,'sha256'),'hex'),$4)`,
        [merchantId, objectKey, content, { importId, source }],
      );
    });
    return importId;
  }

  private eventPayload(row: CustomerRow): Record<string, unknown> {
    return { customerId: row.id, email: row.email, name: row.name, phone: row.phone,
      externalReference: row.external_reference, metadata: row.metadata, version: row.version };
  }

  private async audit(client: pg.PoolClient, merchantId: string, customerId: string, action: string,
                      correlationId: string, metadata: Record<string, unknown>): Promise<void> {
    await client.query(
      `INSERT INTO platform.audit_logs(merchant_id,actor_type,target_type,target_id,action,metadata,correlation_id)
       VALUES($1,'api_key','customer',$2,$3,$4,$5)`, [merchantId, customerId, action, metadata, correlationId],
    );
  }
}
