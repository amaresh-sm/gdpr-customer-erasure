import { randomUUID } from 'node:crypto';
import { EVENT_TYPES } from '../../../packages/contracts/src/events.js';
import { transaction } from '../../../packages/database/src/pool.js';
import { addOutboxEvent } from '../../../packages/messaging/src/outbox.js';
import { logger } from '../../../packages/observability/src/logger.js';
import { eraseCustomerData, ErasureStepError } from './erasure-processor.js';
import { ErasureRepository, type ErasureRequestRow } from './erasure-repository.js';
import { CustomerRepository } from './repository.js';

export interface ErasureRequestView {
  id: string;
  customerId: string;
  status: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  lastError: string | null;
}

function toView(row: ErasureRequestRow): ErasureRequestView {
  return {
    id: row.id,
    customerId: row.customer_id,
    status: row.status,
    attempts: row.attempts,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    completedAt: row.completed_at ? row.completed_at.toISOString() : null,
    lastError: row.last_error,
  };
}

export class ErasureService {
  constructor(
    private readonly repository = new ErasureRepository(),
    private readonly customers = new CustomerRepository(),
  ) {}

  /**
   * Creates (or resumes) the single erasure workflow for a customer. Idempotency keys are
   * scoped per merchant: reusing a key for the same customer or reposting while a request is
   * already tracked both return that same request; reusing a key for a different customer is
   * rejected before any data is read or written.
   */
  async requestErasure(merchantId: string, customerId: string, idempotencyKey: string): Promise<ErasureRequestView> {
    const customer = await this.customers.find(merchantId, customerId);
    if (!customer) throw Object.assign(new Error('customer not found'), { statusCode: 404 });

    const created = await transaction(async (client) => {
      const keyOwner = await this.repository.reserveIdempotencyKey(client, merchantId, idempotencyKey, customerId);
      if (keyOwner !== customerId) throw Object.assign(new Error('idempotency key already used for a different customer'), { statusCode: 409 });

      const request = await this.repository.createRequest(client, merchantId, customerId);
      if (!request) return undefined;
      await this.customers.audit(client, merchantId, customerId, 'customer.erasure_requested', randomUUID(), {});
      return request;
    });
    if (created) return toView(created);

    const existing = await transaction(async (client) => {
      const request = await this.repository.findByCustomer(client, merchantId, customerId);
      if (!request) throw Object.assign(new Error('customer not found'), { statusCode: 404 });
      return await this.repository.resumeIfFailed(client, request.id) ?? request;
    });
    return toView(existing);
  }

  async getRequest(merchantId: string, requestId: string): Promise<ErasureRequestView | undefined> {
    const request = await this.repository.findById(merchantId, requestId);
    return request ? toView(request) : undefined;
  }

  /** Processes one queued erasure request; returns true if work was claimed. */
  async processOne(workerId: string): Promise<boolean> {
    const claimed = await this.repository.claim(workerId);
    if (!claimed) return false;
    try {
      await eraseCustomerData(claimed.merchant_id, claimed.customer_id);
      await transaction(async (client) => {
        await addOutboxEvent(client, {
          eventType: EVENT_TYPES.CUSTOMER_ERASED, aggregateType: 'customer', aggregateId: claimed.customer_id,
          merchantId: claimed.merchant_id, correlationId: randomUUID(),
          payload: { customerId: claimed.customer_id, email: `erased-${claimed.customer_id}@erased.payflow.invalid`, name: 'Erased Customer', phone: null },
        });
        await this.customers.audit(client, claimed.merchant_id, claimed.customer_id, 'customer.erased', randomUUID(), { requestId: claimed.id });
      });
      await this.repository.complete(claimed.id);
    } catch (error) {
      const code = error instanceof ErasureStepError ? error.code : 'erasure_failed';
      logger.error({ error, requestId: claimed.id, errorCode: code }, 'erasure request failed');
      await this.repository.fail(claimed, code);
    }
    return true;
  }
}

export async function runErasureWorker(service: ErasureService, repository: ErasureRepository, signal: AbortSignal): Promise<void> {
  const workerId = `customer-service-erasure-${randomUUID()}`;
  let lastLeaseRecovery = 0;
  while (!signal.aborted) {
    if (Date.now() - lastLeaseRecovery > 30_000) {
      await repository.recoverExpiredLeases();
      lastLeaseRecovery = Date.now();
    }
    const processed = await service.processOne(workerId);
    if (!processed) await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
