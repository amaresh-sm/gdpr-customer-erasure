import { transaction } from '../../../packages/database/src/pool.js';
import { ErasureRepository, type ErasureRequestRow } from './erasure-repository.js';

export interface ErasureRequestView {
  id: string;
  customerId: string;
  status: ErasureRequestRow['status'];
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
  constructor(private readonly repository = new ErasureRepository()) {}

  /**
   * Starts (or resumes) an erasure workflow for a customer. Idempotency keys
   * are scoped to the merchant: reusing a key for the same customer replays
   * the same request, reusing it for a different customer is rejected, and a
   * brand-new key for a customer that already has a request simply returns
   * that existing request instead of starting a second workflow.
   */
  async requestErasure(merchantId: string, customerId: string, idempotencyKey: string): Promise<ErasureRequestView> {
    return await transaction(async (client) => {
      const existingKey = await this.repository.findIdempotencyKey(client, merchantId, idempotencyKey);
      if (existingKey) {
        if (existingKey.customer_id !== customerId) {
          throw Object.assign(new Error('idempotency key reused for a different customer'), { statusCode: 409 });
        }
        const request = await this.repository.findByCustomer(client, merchantId, customerId);
        return toView(request!);
      }

      const customer = await this.repository.findCustomerMerchant(merchantId, customerId);
      if (!customer) throw Object.assign(new Error('customer not found'), { statusCode: 404 });

      const existingRequest = await this.repository.findByCustomer(client, merchantId, customerId);
      const request = existingRequest ?? await this.repository.create(client, merchantId, customerId);
      await this.repository.recordIdempotencyKey(client, merchantId, idempotencyKey, customerId, request.id);
      return toView(request);
    });
  }

  async find(merchantId: string, requestId: string): Promise<ErasureRequestView | undefined> {
    const request = await this.repository.find(merchantId, requestId);
    return request ? toView(request) : undefined;
  }
}
