import { v4 as uuid } from 'uuid';
import { EVENT_TYPES } from '../../../packages/contracts/src/events.js';
import { transaction } from '../../../packages/database/src/pool.js';
import { addOutboxEvent } from '../../../packages/messaging/src/outbox.js';
import { completeIdempotency, requestHash, reserveIdempotency } from '../../../packages/operations/src/idempotency.js';
import { ErasureRepository, toErasureResponse } from './erasure-repository.js';

export class ErasureService {
  constructor(private readonly repository = new ErasureRepository()) {}

  async request(
    merchantId: string,
    customerId: string,
    idempotencyKey: string,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const hash = requestHash({ customerId });
    return transaction(async (client) => {
      const customer = await this.repository.findCustomer(client, merchantId, customerId);
      if (!customer) throw Object.assign(new Error('customer_not_found'), { statusCode: 404 });

      const replay = await reserveIdempotency(client, merchantId, 'customer-erasure', idempotencyKey, hash);
      const existing = await this.repository.findByCustomer(client, merchantId, customerId);
      if (replay && existing && existing.status !== 'failed') {
        return { status: 202, body: toErasureResponse(existing) };
      }

      const created = !existing;
      const request = existing
        ? existing.status === 'failed'
          ? await this.repository.requeue(client, existing.id)
          : existing
        : await this.repository.create(
          client,
          merchantId,
          customerId,
          await this.repository.captureTargets(client, merchantId, customerId, customer.email),
        );

      const body = toErasureResponse(request);
      if (created || existing?.status === 'failed') {
        await this.repository.audit(client, merchantId, customerId, request);
        await addOutboxEvent(client, {
          eventType: EVENT_TYPES.CUSTOMER_ERASURE_REQUESTED,
          aggregateType: 'customer',
          aggregateId: customerId,
          merchantId,
          correlationId: uuid(),
          payload: { customerId, requestId: request.id, status: request.status },
        });
      }
      await completeIdempotency(client, merchantId, 'customer-erasure', idempotencyKey, 202, body);
      return { status: 202, body };
    });
  }

  async get(merchantId: string, requestId: string): Promise<Record<string, unknown> | undefined> {
    const row = await this.repository.findById(merchantId, requestId);
    return row ? toErasureResponse(row) : undefined;
  }
}
