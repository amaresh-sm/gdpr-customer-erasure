/** Returns an exponential retry delay, capped to prevent unbounded backoff. */
export function boundedExponentialBackoffSeconds(attempts: number, maximum = 300): number {
  return Math.min(maximum, 2 ** Math.max(0, attempts));
}
