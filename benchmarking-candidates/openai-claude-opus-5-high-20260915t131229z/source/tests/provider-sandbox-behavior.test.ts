import assert from 'node:assert/strict';
import test from 'node:test';
import { providerSandboxBehavior } from '../packages/payments/src/provider-sandbox-behavior.js';

test('local sandbox tokens select deterministic payment outcomes', () => {
  assert.deepEqual(providerSandboxBehavior('tok_sandbox_decline_4242'), { outcome: 'declined', deliveryMode: 'standard' });
  assert.deepEqual(providerSandboxBehavior('tok_sandbox_timeout_4242'), { outcome: 'timeout', deliveryMode: 'standard' });
  assert.deepEqual(providerSandboxBehavior('tok_live_4242'), { outcome: 'succeeded', deliveryMode: 'standard' });
});

test('local sandbox tokens can exercise duplicate and stale webhooks independently of outcome', () => {
  assert.deepEqual(providerSandboxBehavior('tok_sandbox_decline_duplicate_4242'), { outcome: 'declined', deliveryMode: 'duplicate' });
  assert.deepEqual(providerSandboxBehavior('tok_sandbox_timeout_out_of_order_4242'), { outcome: 'timeout', deliveryMode: 'stale_processing' });
});
