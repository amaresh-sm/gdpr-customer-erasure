import { transaction } from '../../../packages/database/src/pool.js';
import { lockCustomerPrivacy } from '../../../packages/privacy/src/tombstone.js';
import { ErasureRepository, presentErasure, type ErasureRow } from './erasure-repository.js';

export class ErasureService {
  constructor(private readonly repository = new ErasureRepository()) {}

  async request(
    merchantId: string,
    customerId: string,
    idempotencyKey: string,
  ): Promise<Record<string, unknown>> {
    return transaction(async (client) => {
      await this.repository.lockMerchant(client, merchantId);
      await lockCustomerPrivacy(client, merchantId, customerId);

      const keyed = await this.repository.findKey(client, merchantId, idempotencyKey);
      if (keyed) {
        if (keyed.customer_id !== customerId) {
          throw Object.assign(new Error('idempotency_key_conflict'), { statusCode: 409 });
        }
        return presentErasure(await this.retryIfFailed(client, await this.repository.findByRequest(client, keyed.request_id)));
      }

      const existing = await this.repository.findByCustomer(client, merchantId, customerId);
      if (existing) {
        await this.repository.addKey(client, merchantId, customerId, idempotencyKey, existing.id);
        return presentErasure(await this.retryIfFailed(client, existing));
      }

      const customer = await this.repository.findCustomer(client, merchantId, customerId);
      if (!customer) throw Object.assign(new Error('customer_not_found'), { statusCode: 404 });
      const targets = await this.repository.captureTargets(client, merchantId, customerId, customer.email);
      return presentErasure(await this.repository.create(
        client,
        merchantId,
        customerId,
        idempotencyKey,
        targets,
      ));
    });
  }

  async get(merchantId: string, requestId: string): Promise<Record<string, unknown> | undefined> {
    const row = await this.repository.find(merchantId, requestId);
    return row ? presentErasure(row) : undefined;
  }

  private async retryIfFailed(client: import('pg').PoolClient, row: ErasureRow): Promise<ErasureRow> {
    return row.status === 'failed' ? await this.repository.requeue(client, row.id) : row;
  }
}
