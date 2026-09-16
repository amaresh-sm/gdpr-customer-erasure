import { transaction } from '../../../packages/database/src/pool.js';
import { logger } from '../../../packages/observability/src/logger.js';
import {
  ERASURE_STEPS,
  erasureFailureCode,
  isErasureComplete,
  remainingErasureSteps,
  type ErasureStep,
} from '../../../packages/privacy/src/erasure-policy.js';
import {
  completeIdempotency,
  requestHash,
  reserveIdempotency,
} from '../../../packages/operations/src/idempotency.js';
import { ErasureRepository, type ErasureSubject } from './erasure-repository.js';
import {
  ErasureRequestRepository,
  toErasureRequestView,
  type ErasureRequestRow,
  type ErasureRequestView,
} from './erasure-request-repository.js';

const IDEMPOTENCY_SCOPE = 'create-erasure-request';

export class ErasureService {
  constructor(
    private readonly requests = new ErasureRequestRepository(),
    private readonly data = new ErasureRepository(),
  ) {}

  /**
   * Accepts a deletion request. The customer must exist under the authenticated merchant, which the
   * caller checks first, so this never reveals another merchant's customers.
   *
   * A customer has at most one request. Reposting is therefore a resume, not a restart: the original
   * id comes back and finished steps are preserved, and a request that had failed becomes runnable
   * again straight away.
   */
  async request(
    merchantId: string,
    customerId: string,
    idempotencyKey: string,
  ): Promise<{ status: number; body: ErasureRequestView }> {
    const hash = requestHash({ customerId });
    const outcome = await transaction(async (client) => {
      const replay = await reserveIdempotency(client, merchantId, IDEMPOTENCY_SCOPE, idempotencyKey, hash);
      if (replay) return { replay };
      const request = await this.requests.create(client, merchantId, customerId);
      await this.requests.requeue(client, request.id);
      const body = toErasureRequestView(request);
      await completeIdempotency(client, merchantId, IDEMPOTENCY_SCOPE, idempotencyKey, 202, body);
      return { body };
    });
    if ('replay' in outcome) {
      return { status: outcome.replay!.status, body: outcome.replay!.body as ErasureRequestView };
    }
    return { status: 202, body: outcome.body! };
  }

  async get(merchantId: string, requestId: string): Promise<ErasureRequestView | undefined> {
    const row = await this.requests.find(merchantId, requestId);
    return row ? toErasureRequestView(row) : undefined;
  }

  /**
   * Runs the outstanding steps for one claimed request.
   *
   * The subject's contact details are read once, before anything is destroyed, because later steps
   * match captured email and stored artifacts by address rather than by id. A resumed request whose
   * profile is already gone simply has no subject, and the contact-keyed steps become no-ops.
   */
  async process(request: ErasureRequestRow): Promise<void> {
    const subject = await this.data.findSubject(request.merchant_id, request.customer_id);
    let completed = request.completed_steps;
    for (const step of remainingErasureSteps(completed)) {
      try {
        await this.runStep(step, request, subject);
      } catch (error) {
        logger.error({ error, requestId: request.id, step }, 'customer data deletion step failed');
        await this.requests.markFailed(request, erasureFailureCode(step));
        return;
      }
      completed = await this.requests.recordStep(request.id, step);
    }
    if (isErasureComplete(completed)) await this.requests.markCompleted(request.id);
  }

  private async runStep(
    step: ErasureStep,
    request: ErasureRequestRow,
    subject: ErasureSubject | undefined,
  ): Promise<void> {
    const merchantId = request.merchant_id;
    const customerId = request.customer_id;
    switch (step) {
      case 'search_projection':
        return await this.data.removeSearchProjection(merchantId, customerId);
      case 'cache_projection':
        return await this.data.removeCacheProjection(merchantId, customerId);
      case 'analytics':
        return await this.data.removeAnalytics(merchantId, customerId);
      case 'object_storage':
        return await this.data.eraseStoredDocuments(merchantId, customerId);
      case 'email_history':
        return await this.data.eraseEmailHistory(merchantId, customerId, subject);
      case 'event_history':
        return await this.data.eraseEventHistory(merchantId, customerId);
      case 'support':
        return await this.data.eraseSupportHistory(merchantId, customerId);
      case 'provider_profiles':
        return await this.data.eraseProviderProfiles(merchantId, customerId);
      case 'financial_records':
        return await this.data.deidentifyFinancialRecords(merchantId, customerId);
      case 'customer_profile':
        return await this.data.eraseCustomerProfile(merchantId, customerId);
    }
  }

  async close(): Promise<void> {
    await this.data.close();
  }
}

export { ERASURE_STEPS };
