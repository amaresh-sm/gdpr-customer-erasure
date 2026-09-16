import { v4 as uuid } from 'uuid';
import { EVENT_TYPES } from '../../../packages/contracts/src/events.js';
import { transaction } from '../../../packages/database/src/pool.js';
import { addOutboxEvent } from '../../../packages/messaging/src/outbox.js';
import { CustomerRepository } from './repository.js';
import { ErasureRepository } from './erasure-repository.js';

export class ErasureService {
  constructor(
    private readonly erasureRepo = new ErasureRepository(),
    private readonly customerRepo = new CustomerRepository(),
  ) {}

  async create(
    merchantId: string,
    customerId: string,
    idempotencyKey: string,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const customer = await this.customerRepo.find(merchantId, customerId);
    if (!customer) return { status: 404, body: { error: 'customer_not_found' } };

    const existing = await this.erasureRepo.findByCustomer(merchantId, customerId);
    if (existing) {
      return {
        status: 202,
        body: {
          id: existing.id,
          customerId: existing.customer_id,
          status: existing.status,
          attempts: existing.attempts,
          createdAt: existing.created_at,
          updatedAt: existing.updated_at,
          completedAt: existing.completed_at,
          lastError: existing.last_error,
        },
      };
    }

    const request = await transaction(async (client) => {
      const scope = `erasure:${merchantId}`;
      const hash = uuid();
      const idem = await client.query(
        `INSERT INTO operations.idempotency_keys(merchant_id,scope,key,request_hash,expires_at)
         VALUES($1,$2,$3,$4,now()+interval '48 hours')
         ON CONFLICT(merchant_id,scope,key) DO UPDATE
         SET locked_at=now()
         WHERE operations.idempotency_keys.response_status IS NULL
         RETURNING response_status, response_body`,
        [merchantId, scope, idempotencyKey, hash],
      );
      if (idem.rows[0]?.response_status != null) {
        return { replay: { status: idem.rows[0].response_status, body: idem.rows[0].response_body as Record<string, unknown> } };
      }

      const record = await this.erasureRepo.create(client, merchantId, customerId);
      await addOutboxEvent(client, {
        eventType: EVENT_TYPES.CUSTOMER_DATA_ERASED,
        aggregateType: 'customer',
        aggregateId: customerId,
        merchantId,
        correlationId: uuid(),
        payload: { customerId, erasureRequestId: record.id },
      });
      await client.query(
        `UPDATE operations.idempotency_keys
         SET response_status=$4, response_body=$5
         WHERE merchant_id=$1 AND scope=$2 AND key=$3`,
        [
          merchantId,
          scope,
          idempotencyKey,
          202,
          JSON.stringify({
            id: record.id,
            customerId: record.customer_id,
            status: record.status,
            attempts: record.attempts,
            createdAt: record.created_at,
            updatedAt: record.updated_at,
            completedAt: record.completed_at,
            lastError: record.last_error,
          }),
        ],
      );
      return { record };
    });

    if ('replay' in request) return { status: request.replay.status, body: request.replay.body };

    return {
      status: 202,
      body: {
        id: request.record.id,
        customerId: request.record.customer_id,
        status: request.record.status,
        attempts: request.record.attempts,
        createdAt: request.record.created_at,
        updatedAt: request.record.updated_at,
        completedAt: request.record.completed_at,
        lastError: request.record.last_error,
      },
    };
  }
}