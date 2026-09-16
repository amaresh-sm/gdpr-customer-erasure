import { boundedExponentialBackoffSeconds } from '../../operations/src/retry-policy.js';

/** Returns the retry delay used for transient email-provider delivery failures. */
export function nextDeliveryDelaySeconds(attempts: number): number {
  return boundedExponentialBackoffSeconds(attempts);
}
