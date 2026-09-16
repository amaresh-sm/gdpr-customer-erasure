import { transaction } from '../../../packages/database/src/pool.js';
import { completeIdempotency, requestHash, reserveIdempotency } from '../../payment-service/src/idempotency.js';
import { ErasureRepository } from './erasure-repository.js';
import { toErasureResponse, type ErasureRequestResponse, type ErasureRequestRow } from './erasure-policy.js';

const IDEMPOTENCY_SCOPE = 'customer-erasure';

export class ErasureService {
  constructor(private readonly repository = new ErasureRepository()) {}

  async create(
    merchantId: string,
    customerId: string,
    idempotencyKey: string,
  ): Promise<{ status: number; body: ErasureRequestResponse }> {
    return transaction(async (client) => {
      const customer = await this.repository.findCustomer(client, merchantId, customerId);
      if (!customer) {
        throw Object.assign(new Error('customer_not_found'), { statusCode: 404 });
      }

      const hash = requestHash({ customerId });
      const replay = await reserveIdempotency(client, merchantId, IDEMPOTENCY_SCOPE, idempotencyKey, hash);
      const existing = await this.repository.findByCustomer(client, merchantId, customerId);
      if (replay && existing) {
        return { status: 202, body: toErasureResponse(await this.resume(client, existing)) };
      }
      if (replay) {
        return { status: replay.status, body: replay.body as ErasureRequestResponse };
      }

      const request = existing
        ? await this.resume(client, existing)
        : await this.repository.create(client, merchantId, customerId);

      if (!existing) {
        await client.query(
          `INSERT INTO platform.audit_logs(merchant_id,actor_type,target_type,target_id,action,metadata,correlation_id)
           VALUES($1,'api_key','erasure_request',$2,'customer.erasure.accepted',$3,$2::uuid)`,
          [merchantId, request.id, { customerId }],
        );
      }

      const body = toErasureResponse(request);
      await completeIdempotency(client, merchantId, IDEMPOTENCY_SCOPE, idempotencyKey, 202, body);
      return { status: 202, body };
    });
  }

  async get(merchantId: string, requestId: string): Promise<ErasureRequestResponse | undefined> {
    const request = await this.repository.findById(merchantId, requestId);
    return request ? toErasureResponse(request) : undefined;
  }

  private async resume(client: Parameters<ErasureRepository['requeue']>[0], existing: ErasureRequestRow): Promise<ErasureRequestRow> {
    return existing.status === 'failed' ? this.repository.requeue(client, existing.id) : existing;
  }
}
