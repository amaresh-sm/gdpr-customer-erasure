const PII_KEYS = new Set([
  'email',
  'name',
  'phone',
  'customerEmail',
  'billingName',
  'billingAddress',
  'billing_name',
  'billing_address',
  'line1',
  'line2',
  'city',
  'region',
  'postalCode',
  'postal_code',
  'externalReference',
  'external_reference',
  'subject',
  'body',
  'text',
  'html',
  'destination',
]);

export function erasedCustomerRecord(customerId: string): Record<string, unknown> {
  return { id: customerId, status: 'erased' };
}

export function classifyErasureError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('mailpit')) return 'notification_store_unavailable';
  if (message.includes('opensearch') || message.includes('index_not_found') || message.includes('search_')) {
    return 'search_index_unavailable';
  }
  if (message.includes('minio') || message.includes('S3') || message.includes('object')) {
    return 'object_store_unavailable';
  }
  if (message.includes('ECONNREFUSED') && message.includes('6379')) return 'cache_unavailable';
  if (message.includes('Redis') || message.includes('redis')) return 'cache_unavailable';
  return 'cleanup_failed';
}

/** Removes known personal-data keys from event and job payloads. */
export function redactPii(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactPii(item));
  if (!value || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(source)) {
    if (PII_KEYS.has(key)) continue;
    if (key === 'customer' && nested && typeof nested === 'object' && !Array.isArray(nested)) {
      const customer = nested as Record<string, unknown>;
      result[key] = erasedCustomerRecord(
        typeof customer.id === 'string'
          ? customer.id
          : typeof customer.customerId === 'string' ? customer.customerId : 'erased',
      );
      continue;
    }
    if (key === 'customerSnapshot' || key === 'customer_snapshot' || key === 'billing_snapshot') {
      const snapshot = nested && typeof nested === 'object' && !Array.isArray(nested)
        ? nested as Record<string, unknown>
        : {};
      result[key] = erasedCustomerRecord(typeof snapshot.id === 'string' ? snapshot.id : 'erased');
      continue;
    }
    result[key] = redactPii(nested);
  }
  result.erased = true;
  return result;
}
