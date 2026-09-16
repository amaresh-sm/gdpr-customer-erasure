/**
 * Personal-data keys stripped from retained operational payloads (outbox events,
 * job payloads, dead letters, analytics properties, audit metadata). Financial
 * fields such as amounts, currencies, and statuses are never removed.
 */
export const PII_PAYLOAD_KEYS = [
  'email',
  'name',
  'phone',
  'externalReference',
  'metadata',
  'customerEmail',
  'billingName',
  'billingAddress',
  'value',
  'line1',
  'line2',
  'city',
  'region',
  'postalCode',
  'country',
  'subject',
  'body',
  'last4',
  'destination',
] as const;

/** Tombstone replacing customer snapshots in retained financial records. */
export const ERASED_CUSTOMER_TOMBSTONE: Readonly<Record<string, unknown>> = Object.freeze({ erased: true });

/** Returns a shallow copy of the payload without personal-data keys. */
export function scrubPayload(payload: unknown, extraKeys: readonly string[] = []): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return {};
  const removed = new Set<string>([...PII_PAYLOAD_KEYS, ...extraKeys]);
  const scrubbed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (!removed.has(key)) scrubbed[key] = value;
  }
  return scrubbed;
}

/** Erasure idempotency keys must be 8-200 characters per the public API contract. */
export function isValidErasureIdempotencyKey(key: unknown): key is string {
  return typeof key === 'string' && key.length >= 8 && key.length <= 200;
}

export interface ErasureRequestRecord {
  id: string;
  merchant_id: string;
  customer_id: string;
  status: string;
  attempts: number;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

export interface ErasureRequestBody {
  id: string;
  customerId: string;
  status: string;
  attempts: number;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  lastError: string | null;
}

/** Maps a stored erasure request to the documented public API shape. */
export function serializeErasureRequest(row: ErasureRequestRecord): ErasureRequestBody {
  return {
    id: row.id,
    customerId: row.customer_id,
    status: row.status,
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    lastError: row.last_error,
  };
}
