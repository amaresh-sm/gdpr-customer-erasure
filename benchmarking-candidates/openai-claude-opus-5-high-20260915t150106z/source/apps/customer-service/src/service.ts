import { v4 as uuid } from 'uuid';
import type pg from 'pg';
import { EVENT_TYPES } from '../../../packages/contracts/src/events.js';
import type { CreateCustomer } from '../../../packages/contracts/src/domain.js';
import { transaction } from '../../../packages/database/src/pool.js';
import { addOutboxEvent } from '../../../packages/messaging/src/outbox.js';
import { DOCUMENT_BUCKET, ensureBucket, objectStore } from '../../../packages/storage/src/minio.js';
import {
  CustomerRepository,
  type AddressInput,
  type ContactInput,
  type CustomerRow,
  type PaymentMethodInput,
} from './repository.js';

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

  async ensureProviderCustomer(merchantId: string, customerId: string, providerName: string): Promise<string> {
    const providerCustomerId = `pcus_${uuid().replaceAll('-', '')}`;
    const mapping = await transaction(async (client) => await this.repository.ensureProviderCustomer(
      client, merchantId, customerId, providerName, providerCustomerId,
    ));
    if (!mapping) throw Object.assign(new Error('customer not found'), { statusCode: 404 });
    return mapping.provider_customer_id;
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

  async addAddress(client: pg.PoolClient, merchantId: string, customerId: string, input: AddressInput): Promise<string> {
    const addressId = await this.repository.addAddress(client, merchantId, customerId, input);
    if (!addressId) throw Object.assign(new Error('customer not found'), { statusCode: 404 });
    const correlationId = uuid();
    await this.audit(client, merchantId, customerId, 'customer.address.created', correlationId, { addressId, ...input });
    await addOutboxEvent(client, { eventType: EVENT_TYPES.CUSTOMER_ADDRESS_CHANGED, aggregateType: 'customer',
      aggregateId: customerId, merchantId, correlationId, payload: { customerId, addressId, ...input } });
    return addressId;
  }

  async addContact(client: pg.PoolClient, merchantId: string, customerId: string,
                   input: ContactInput): Promise<string> {
    const contactId = await this.repository.addContact(client, merchantId, customerId, input);
    if (!contactId) throw Object.assign(new Error('customer not found'), { statusCode: 404 });
    const correlationId = uuid();
    await this.audit(client, merchantId, customerId, 'customer.contact.created', correlationId, { contactId, ...input });
    await addOutboxEvent(client, { eventType: EVENT_TYPES.CUSTOMER_CONTACT_CHANGED, aggregateType: 'customer',
      aggregateId: customerId, merchantId, correlationId, payload: { customerId, contactId, ...input } });
    return contactId;
  }

  async attachPaymentMethod(client: pg.PoolClient, merchantId: string, customerId: string,
                            input: PaymentMethodInput): Promise<string> {
    const paymentMethodId = await this.repository.attachPaymentMethod(client, merchantId, customerId, input);
    if (!paymentMethodId) throw Object.assign(new Error('customer not found'), { statusCode: 404 });
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
    const created = await this.repository.createSupportTicket(client, merchantId, customerId, subject, body);
    if (!created) throw Object.assign(new Error('customer not found'), { statusCode: 404 });
    await addOutboxEvent(client, { eventType: EVENT_TYPES.SUPPORT_MESSAGE_CREATED, aggregateType: 'customer',
      aggregateId: customerId, merchantId, correlationId: uuid(), payload: { customerId, ticketId: created.ticketId,
        messageId: created.messageId, subject, body } });
    return created.ticketId;
  }

  async importCustomerArtifact(merchantId: string, source: string, content: string): Promise<string> {
    await ensureBucket();
    const importId = uuid();
    const objectKey = `${merchantId}/imports/${importId}.json`;
    await objectStore.putObject(DOCUMENT_BUCKET, objectKey, content, Buffer.byteLength(content), { 'Content-Type': 'application/json' });
    await transaction(async (client) => {
      await this.repository.recordImport(client, { importId, merchantId, source, objectKey, content });
    });
    return importId;
  }

  private eventPayload(row: CustomerRow): Record<string, unknown> {
    return { customerId: row.id, email: row.email, name: row.name, phone: row.phone,
      externalReference: row.external_reference, metadata: row.metadata, version: row.version };
  }

  private async audit(client: pg.PoolClient, merchantId: string, customerId: string, action: string,
                      correlationId: string, metadata: Record<string, unknown>): Promise<void> {
    await this.repository.audit(client, merchantId, customerId, action, correlationId, metadata);
  }
}
