const PII_KEYS = new Set([
  'email',
  'name',
  'phone',
  'customerEmail',
  'customer_email',
  'billingName',
  'billing_name',
  'billingAddress',
  'billing_address',
  'externalReference',
  'external_reference',
  'line1',
  'line2',
  'city',
  'region',
  'postalCode',
  'postal_code',
  'destination',
  'text_body',
  'html_body',
  'textBody',
  'htmlBody',
  'body',
  'subject',
  'value',
  'description',
]);

const CUSTOMER_OBJECT_KEYS = new Set([
  'customer',
  'customerSnapshot',
  'customer_snapshot',
  'billing_snapshot',
]);

export function anonymizedEmail(customerId: string): string {
  return `erased-${customerId}@erased.invalid`;
}

export function anonymizedExternalReference(customerId: string): string {
  return `erased-${customerId}`;
}

export function anonymizedDisplayName(): string {
  return 'Erased Customer';
}

export function redactedCustomerRecord(customerId: string): Record<string, unknown> {
  return {
    id: customerId,
    status: 'erased',
    email: anonymizedEmail(customerId),
    name: anonymizedDisplayName(),
    phone: null,
    external_reference: anonymizedExternalReference(customerId),
    metadata: {},
  };
}

export function mapErasureError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith('mailpit_') || message.includes('mailpit')) return 'mail_provider_unavailable';
  if (message.includes('opensearch') || message.includes('search_index')) return 'search_index_unavailable';
  if (message.includes('ECONNREFUSED') && message.includes('6379')) return 'cache_unavailable';
  if (message.includes('minio') || message.includes('S3') || message.includes('object_store')) return 'object_store_unavailable';
  if (message.includes('cache_unavailable')) return 'cache_unavailable';
  return 'erasure_failed';
}

export function redactPii(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactPii);
  if (!value || typeof value !== 'object') return value;
  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(input)) {
    if (PII_KEYS.has(key) || key.toLowerCase().includes('email')) {
      output[key] = null;
      continue;
    }
    if (CUSTOMER_OBJECT_KEYS.has(key)) {
      output[key] = redactCustomerObject(nested);
      continue;
    }
    output[key] = redactPii(nested);
  }
  return output;
}

function redactCustomerObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { status: 'erased' };
  const input = value as Record<string, unknown>;
  const id = typeof input.id === 'string' ? input.id : undefined;
  return id ? { id, status: 'erased' } : { status: 'erased' };
}

export interface PublicErasureRequest {
  id: string;
  customerId: string;
  status: 'pending' | 'processing' | 'failed' | 'completed';
  attempts: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  lastError: string | null;
}

export interface ErasureRequestRow {
  id: string;
  merchant_id: string;
  customer_id: string;
  status: PublicErasureRequest['status'];
  attempts: number;
  last_error: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  completed_at: Date | string | null;
}

export function toPublicErasureRequest(row: ErasureRequestRow): PublicErasureRequest {
  return {
    id: row.id,
    customerId: row.customer_id,
    status: row.status,
    attempts: row.attempts,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    completedAt: row.completed_at ? toIso(row.completed_at) : null,
    lastError: row.last_error,
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
