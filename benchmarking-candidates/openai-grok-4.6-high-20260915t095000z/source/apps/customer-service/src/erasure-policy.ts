export interface ErasureRequestRow {
  id: string;
  merchant_id: string;
  customer_id: string;
  status: 'pending' | 'processing' | 'failed' | 'completed';
  attempts: number;
  last_error: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  completed_at: Date | string | null;
}

export interface ErasureRequestResponse {
  id: string;
  customerId: string;
  status: ErasureRequestRow['status'];
  attempts: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  lastError: string | null;
}

export function toIsoTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function toErasureResponse(row: ErasureRequestRow): ErasureRequestResponse {
  return {
    id: row.id,
    customerId: row.customer_id,
    status: row.status,
    attempts: row.attempts,
    createdAt: toIsoTimestamp(row.created_at),
    updatedAt: toIsoTimestamp(row.updated_at),
    completedAt: row.completed_at ? toIsoTimestamp(row.completed_at) : null,
    lastError: row.last_error,
  };
}

export function importContainsCustomer(content: string, customerId: string, emails: string[]): boolean {
  const normalized = content.toLowerCase();
  if (content.includes(customerId)) return true;
  return emails.some((email) => email.length > 0 && normalized.includes(email.toLowerCase()));
}

export function redactDocumentCustomer(document: Record<string, unknown>, customerId: string): Record<string, unknown> {
  const next = { ...document };
  if (next.customer && typeof next.customer === 'object') {
    next.customer = { id: customerId, status: 'erased' };
  }
  if (typeof next.email === 'string') delete next.email;
  if (typeof next.name === 'string') delete next.name;
  if (typeof next.phone === 'string') delete next.phone;
  if (typeof next.customerEmail === 'string') delete next.customerEmail;
  return next;
}

export function erasedEmail(customerId: string): string {
  return `erased-${customerId}@erased.invalid`;
}

export function erasedExternalReference(customerId: string): string {
  return `erased-${customerId}`;
}

export function erasureErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/opensearch|search_/i.test(message)) return 'search_unavailable';
  if (/redis|cache_/i.test(message)) return 'cache_unavailable';
  if (/minio|s3|document_store|NoSuchBucket/i.test(message)) return 'document_store_unavailable';
  if (/mailpit|notification_store/i.test(message)) return 'notification_store_unavailable';
  return 'cleanup_failed';
}
