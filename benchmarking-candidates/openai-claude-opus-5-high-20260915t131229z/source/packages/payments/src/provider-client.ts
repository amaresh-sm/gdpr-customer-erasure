import { z } from 'zod';
import { config } from '../../config/src/index.js';
import type { ProviderOutcome, WebhookDeliveryMode } from './provider-sandbox-behavior.js';

const providerPaymentSchema = z.object({
  id: z.string().min(4),
  status: z.enum(['processing', 'succeeded', 'failed']),
});

const providerRefundSchema = z.object({
  id: z.string().min(4),
  status: z.enum(['pending', 'succeeded', 'failed']),
});

export type ProviderPayment = z.infer<typeof providerPaymentSchema>;
export type ProviderRefund = z.infer<typeof providerRefundSchema>;

export class PaymentProviderError extends Error {
  constructor(
    readonly code: 'provider_timeout' | 'provider_unavailable' | 'provider_rejected' | 'provider_response_invalid',
    readonly retryable: boolean,
    readonly providerStatus?: number,
    cause?: unknown,
  ) {
    super(code, { cause });
  }
}

export function isRetryableProviderStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export class PaymentProviderClient {
  private readonly baseUrl: string;

  constructor(baseUrl = config().PROCESSOR_URL) {
    this.baseUrl = baseUrl;
  }

  async createPaymentIntent(input: {
    requestId: string;
    merchantId: string;
    paymentId: string;
    amount: number;
    currency: string;
    paymentMethodId: string;
    providerCustomerId: string;
    customer: { id: string; email: string; name: string; externalReference: string };
    outcome: ProviderOutcome;
    deliveryMode: WebhookDeliveryMode;
    webhookUrl: string;
  }): Promise<ProviderPayment> {
    return await this.post('/v1/payment-intents', input, input.requestId, providerPaymentSchema);
  }

  async createRefund(input: {
    requestId: string;
    refundId: string;
    paymentId: string;
    merchantId: string;
    providerPaymentId: string;
    amount: number;
    currency: string;
    reason: string;
    webhookUrl: string;
  }): Promise<ProviderRefund> {
    return await this.post(
      `/v1/payment-intents/${encodeURIComponent(input.providerPaymentId)}/refunds`,
      input,
      input.requestId,
      providerRefundSchema,
    );
  }

  private async post<T extends z.ZodType>(path: string, body: unknown, requestId: string, schema: T): Promise<z.infer<T>> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-request-id': requestId },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
      });
    } catch (error) {
      const code = error instanceof DOMException && error.name === 'TimeoutError' ? 'provider_timeout' : 'provider_unavailable';
      throw new PaymentProviderError(code, true, undefined, error);
    }

    if (!response.ok) {
      throw new PaymentProviderError(
        isRetryableProviderStatus(response.status) ? 'provider_unavailable' : 'provider_rejected',
        isRetryableProviderStatus(response.status),
        response.status,
      );
    }

    try {
      return schema.parse(await response.json());
    } catch (error) {
      throw new PaymentProviderError('provider_response_invalid', false, response.status, error);
    }
  }
}
