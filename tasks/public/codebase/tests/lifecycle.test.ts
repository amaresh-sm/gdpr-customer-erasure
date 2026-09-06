import assert from 'node:assert/strict';
import test from 'node:test';
import { nextDeliveryDelaySeconds } from '../packages/notifications/src/delivery-policy.js';
import { boundedExponentialBackoffSeconds } from '../packages/operations/src/retry-policy.js';
import { isRetryableProviderStatus } from '../packages/payments/src/provider-client.js';

test('provider errors distinguish transient transport failures from terminal rejections', () => {
  assert.equal(isRetryableProviderStatus(408), true);
  assert.equal(isRetryableProviderStatus(429), true);
  assert.equal(isRetryableProviderStatus(503), true);
  assert.equal(isRetryableProviderStatus(422), false);
});

test('durable jobs use bounded exponential backoff', () => {
  assert.equal(boundedExponentialBackoffSeconds(1), 2);
  assert.equal(boundedExponentialBackoffSeconds(5), 32);
  assert.equal(boundedExponentialBackoffSeconds(20), 300);
});

test('email delivery backoff is bounded and never becomes negative', () => {
  assert.equal(nextDeliveryDelaySeconds(0), 1);
  assert.equal(nextDeliveryDelaySeconds(5), 32);
  assert.equal(nextDeliveryDelaySeconds(20), 300);
});
