import { v4 as uuid } from 'uuid';
import { EVENT_TYPES } from '../../../../packages/contracts/src/events.js';
import { transaction } from '../../../../packages/database/src/pool.js';
import { addOutboxEvent } from '../../../../packages/messaging/src/outbox.js';
import { logger } from '../../../../packages/observability/src/logger.js';
import { classifyErasureError } from '../../../../packages/privacy/src/redaction.js';
import { toErasureRequestDto, type ErasureRequestDto } from './dto.js';
import {
  deleteObject,
  purgeCapturedEmail,
  removeCustomerFromCache,
  removeCustomerFromSearchIndex,
  rewriteInvoiceObject,
  rewriteReceiptObject,
} from './external-systems.js';
import { ErasureRepository, type ClaimedErasureRequest } from './repository.js';

export class ErasureService {
  constructor(private readonly repository = new ErasureRepository()) {}

  async createOrResume(merchantId: string, customerId: string, idempotencyKey: string): Promise<{ status: number; body: ErasureRequestDto }> {
    const customer = await this.repository.findCustomer(merchantId, customerId);
    if (!customer) throw Object.assign(new Error('customer not found'), { statusCode: 404 });
    const result = await this.repository.createOrResume(merchantId, customerId, idempotencyKey);
    return { status: result.status, body: toErasureRequestDto(result.body) };
  }

  async find(merchantId: string, requestId: string): Promise<ErasureRequestDto | undefined> {
    const row = await this.repository.findById(merchantId, requestId);
    return row ? toErasureRequestDto(row) : undefined;
  }

  /** Processes exactly one claimed erasure request to completion, or records a retryable failure. */
  async processOne(request: ClaimedErasureRequest): Promise<void> {
    try {
      const step = await this.repository.runDatabaseStep(request.merchant_id, request.customer_id);

      for (const invoice of step.invoicesToRewrite) {
        if (!invoice.object_key) continue;
        const lines = await this.repository.invoiceLines(invoice.id);
        const checksum = await rewriteInvoiceObject(invoice, request.customer_id, lines);
        if (checksum) await this.repository.updateManifestChecksum(invoice.object_key, checksum);
      }
      for (const receipt of step.receiptsToRewrite) {
        const checksum = await rewriteReceiptObject(receipt, request.customer_id);
        await this.repository.updateManifestChecksum(receipt.object_key, checksum);
      }
      for (const objectKey of step.importObjectKeysToDelete) await deleteObject(objectKey);

      await removeCustomerFromSearchIndex(request.merchant_id, request.customer_id);
      await removeCustomerFromCache(request.merchant_id, request.customer_id);
      await purgeCapturedEmail(request.target_emails);

      await transaction(async (client) => {
        await addOutboxEvent(client, {
          eventType: EVENT_TYPES.CUSTOMER_ERASURE_COMPLETED, aggregateType: 'customer',
          aggregateId: request.customer_id, merchantId: request.merchant_id, correlationId: uuid(),
          payload: { customerId: request.customer_id, requestId: request.id },
        });
      });
      await this.repository.markCompleted(request.id);
    } catch (error) {
      const code = classifyErasureError(error);
      logger.warn({ requestId: request.id, code, error }, 'erasure attempt failed, will retry');
      await this.repository.markFailed(request.id, request.attempts, code);
    }
  }
}
