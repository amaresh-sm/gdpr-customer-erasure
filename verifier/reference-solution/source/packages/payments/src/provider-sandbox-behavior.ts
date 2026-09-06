export type ProviderOutcome = 'succeeded' | 'declined' | 'timeout';
export type WebhookDeliveryMode = 'standard' | 'duplicate' | 'stale_processing';

export interface ProviderSandboxBehavior {
  outcome: ProviderOutcome;
  deliveryMode: WebhookDeliveryMode;
}

/** Maps documented local sandbox tokens to deterministic provider behavior. */
export function providerSandboxBehavior(paymentMethodToken: string): ProviderSandboxBehavior {
  const outcome: ProviderOutcome = paymentMethodToken.startsWith('tok_sandbox_decline_')
    ? 'declined'
    : paymentMethodToken.startsWith('tok_sandbox_timeout_') ? 'timeout' : 'succeeded';
  const deliveryMode: WebhookDeliveryMode = paymentMethodToken.includes('_duplicate_')
    ? 'duplicate'
    : paymentMethodToken.includes('_out_of_order_') ? 'stale_processing' : 'standard';
  return { outcome, deliveryMode };
}
