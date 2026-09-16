export type ErasureRequestStatus = 'pending' | 'processing' | 'failed' | 'completed';

/** The public shape of a data deletion request, as documented in docs/privacy-api.md. */
export interface ErasureRequestSnapshot {
  id: string;
  customer_id: string;
  status: ErasureRequestStatus;
  attempts: number;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

export function isValidErasureIdempotencyKey(key: unknown): key is string {
  return typeof key === 'string' && key.length >= 8 && key.length <= 200;
}

export function serializeErasureRequest(row: ErasureRequestSnapshot): Record<string, unknown> {
  return {
    id: row.id,
    customerId: row.customer_id,
    status: row.status,
    attempts: row.attempts,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    completedAt: row.completed_at ? row.completed_at.toISOString() : null,
    lastError: row.last_error,
  };
}
