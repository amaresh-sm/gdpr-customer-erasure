export const ERASURE_STATUSES = ['pending', 'processing', 'failed', 'completed'] as const;
export type ErasureStatus = (typeof ERASURE_STATUSES)[number];

export interface ErasureRequestRow {
  id: string;
  merchant_id: string;
  customer_id: string;
  status: ErasureStatus;
  attempts: number;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

export interface ErasureRequestResponse {
  id: string;
  customerId: string;
  status: ErasureStatus;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  lastError: string | null;
}

export function toErasureResponse(row: ErasureRequestRow): ErasureRequestResponse {
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
  return (value instanceof Date ? value : new Date(value)).toISOString();
}
