import { v4 as uuid } from 'uuid';
import { transaction } from '../../../packages/database/src/pool.js';
import {
  serializeErasureRequest,
  type ErasureRequestBody,
} from '../../../packages/privacy/src/redact.js';
import { ErasureRepository } from './erasure-repository.js';

function keyConflict(): Error {
  return Object.assign(new Error('idempotency key reused with a different customer'), { statusCode: 409 });
}

export class ErasureService {
  constructor(private readonly repository = new ErasureRepository()) {}

  /**
   * Starts or resumes a customer's data deletion request. Idempotency keys are
   * scoped to the merchant: reusing a key for the same customer returns the same
   * request, while reusing it for another customer conflicts. A customer has at
   * most one workflow; a fresh key returns the existing request.
   */
  async request(merchantId: string, customerId: string, key: string): Promise<ErasureRequestBody | undefined> {
    return transaction(async (client) => {
      if (!await this.repository.customerExists(client, merchantId, customerId)) return undefined;

      const bound = await this.repository.findKeyForUpdate(client, merchantId, key);
      if (bound) {
        if (bound.customer_id !== customerId) throw keyConflict();
        const existing = await this.repository.findByIdForUpdate(client, merchantId, bound.request_id);
        return serializeErasureRequest(existing!);
      }

      const existing = await this.repository.findByCustomerForUpdate(client, merchantId, customerId);
      if (existing) {
        await this.bindKeyOrConflict(client, merchantId, key, customerId, existing.id);
        const current = existing.status === 'failed' ? await this.repository.requeue(client, existing.id) : existing;
        return serializeErasureRequest(current);
      }

      const { row, created } = await this.repository.create(client, merchantId, customerId);
      await this.bindKeyOrConflict(client, merchantId, key, customerId, row.id);
      if (created) {
        await this.repository.audit(client, merchantId, customerId, 'customer.erasure.requested', uuid(), { requestId: row.id });
      }
      return serializeErasureRequest(row);
    });
  }

  async find(merchantId: string, requestId: string): Promise<ErasureRequestBody | undefined> {
    const row = await this.repository.findById(merchantId, requestId);
    return row ? serializeErasureRequest(row) : undefined;
  }

  private async bindKeyOrConflict(
    client: import('pg').PoolClient,
    merchantId: string,
    key: string,
    customerId: string,
    requestId: string,
  ): Promise<void> {
    if (await this.repository.bindKey(client, merchantId, key, customerId, requestId)) return;
    const existing = await this.repository.findKeyForUpdate(client, merchantId, key);
    if (!existing || existing.customer_id !== customerId) throw keyConflict();
  }
}
