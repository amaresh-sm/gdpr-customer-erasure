import { settings } from './clients.js';

export async function api<T>(apiKey: string, path: string, options: {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  expected?: number;
  timeoutMs?: number;
} = {}): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = { authorization: `Bearer ${apiKey}`, ...options.headers };
  // A broken candidate endpoint must not hold the complete hidden suite open forever.
  const init: RequestInit = {
    method: options.method ?? 'GET',
    headers,
    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
  };
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(`${settings.gateway}${path}`, init);
  const body = await response.json() as T;
  if (options.expected !== undefined && response.status !== options.expected) {
    throw new Error(`${init.method} ${path}: expected ${options.expected}, got ${response.status}: ${JSON.stringify(body)}`);
  }
  return { status: response.status, body };
}

export async function poll<T>(operation: () => Promise<T>, predicate: (value: T) => boolean,
                              label: string, attempts = 80): Promise<T> {
  for (let index = 0; index < attempts; index += 1) {
    const value = await operation();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 125));
  }
  throw new Error(`timed out waiting for ${label}`);
}
