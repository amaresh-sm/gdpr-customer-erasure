export const ERASED_DISPLAY_NAME = 'ERASED';
export const ERASED_TOKEN = 'erased';

const PII_KEYS = new Set([
  'email',
  'name',
  'phone',
  'customeremail',
  'customer_email',
  'billingname',
  'billing_name',
  'displayname',
  'display_name',
  'destination',
  'externalreference',
  'external_reference',
  'line1',
  'line2',
  'city',
  'region',
  'postalcode',
  'postal_code',
  'providertoken',
  'provider_token',
  'last4',
  'brand',
  'value',
  'body',
  'subject',
  'text_body',
  'html_body',
  'textbody',
  'htmlbody',
  'notes',
]);

export function erasedEmail(customerId: string): string {
  return `erased-${customerId}@erased.invalid`;
}

export function erasedExternalReference(customerId: string): string {
  return `erased:${customerId}`;
}

export function anonymizedCustomerRecord(customerId: string): {
  email: string;
  name: string;
  phone: null;
  external_reference: string;
  metadata: Record<string, never>;
  status: 'erased';
} {
  return {
    email: erasedEmail(customerId),
    name: ERASED_DISPLAY_NAME,
    phone: null,
    external_reference: erasedExternalReference(customerId),
    metadata: {},
    status: 'erased',
  };
}

export function anonymizedCustomerSnapshot(customerId: string): Record<string, unknown> {
  const record = anonymizedCustomerRecord(customerId);
  return {
    id: customerId,
    email: record.email,
    name: record.name,
    phone: record.phone,
    external_reference: record.external_reference,
    status: record.status,
  };
}

export function redactJson(value: unknown, customerId?: string): unknown {
  if (Array.isArray(value)) return value.map((item) => redactJson(item, customerId));
  if (!value || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(source)) {
    if (PII_KEYS.has(key.toLowerCase())) {
      result[key] = replacementFor(key, customerId);
      continue;
    }
    if (key === 'customer' || key === 'customerSnapshot' || key === 'customer_snapshot' || key === 'billing_snapshot' || key === 'billingAddress' || key === 'billing_address') {
      result[key] = typeof nested === 'object' && nested !== null
        ? redactJson(nested, customerId)
        : anonymizedCustomerSnapshot(customerId ?? ERASED_TOKEN);
      continue;
    }
    result[key] = redactJson(nested, customerId);
  }
  return result;
}

function replacementFor(key: string, customerId?: string): string | null {
  const normalized = key.toLowerCase();
  if (normalized.includes('email') || normalized === 'destination') {
    return customerId ? erasedEmail(customerId) : ERASED_DISPLAY_NAME.toLowerCase();
  }
  if (normalized.includes('phone') || normalized === 'last4') return null;
  if (normalized.includes('token')) return ERASED_TOKEN;
  if (normalized === 'externalreference' || normalized === 'external_reference') {
    return customerId ? erasedExternalReference(customerId) : ERASED_TOKEN;
  }
  return ERASED_DISPLAY_NAME;
}

export function erasureErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('mailpit')) return 'email_cleanup_failed';
  if (message.includes('opensearch') || message.includes('index_not_found') || message.includes('search')) {
    return 'search_cleanup_failed';
  }
  if (message.includes('minio') || message.includes('S3') || message.includes('object')) {
    return 'document_cleanup_failed';
  }
  if (message.includes('redis') || message.includes('ECONNREFUSED')) return 'cache_cleanup_failed';
  return 'erasure_processing_failed';
}
