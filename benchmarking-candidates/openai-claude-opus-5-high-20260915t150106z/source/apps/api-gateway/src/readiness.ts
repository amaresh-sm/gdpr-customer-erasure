import type { Config } from '../../../packages/config/src/index.js';

interface DependencyStatus {
  name: string;
  ready: boolean;
  latencyMs: number;
}

async function check(name: string, baseUrl: string): Promise<DependencyStatus> {
  const started = performance.now();
  try {
    const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1_000) });
    return { name, ready: response.ok, latencyMs: Math.round(performance.now() - started) };
  } catch {
    return { name, ready: false, latencyMs: Math.round(performance.now() - started) };
  }
}

/** Reports whether every HTTP dependency needed to serve merchant traffic is reachable. */
export async function readiness(settings: Config): Promise<{ ready: boolean; dependencies: DependencyStatus[] }> {
  const dependencies = await Promise.all([
    check('customer-service', settings.CUSTOMER_SERVICE_URL),
    check('payment-service', settings.PAYMENT_SERVICE_URL),
  ]);
  return { ready: dependencies.every((dependency) => dependency.ready), dependencies };
}
