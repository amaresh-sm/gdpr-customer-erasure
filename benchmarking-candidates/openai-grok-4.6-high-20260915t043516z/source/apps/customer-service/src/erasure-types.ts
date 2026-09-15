export interface ErasureRequestRow {
  id: string;
  merchant_id: string;
  customer_id: string;
  status: 'pending' | 'processing' | 'failed' | 'completed';
  attempts: number;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

export interface PublicErasureRequest {
  id: string;
  customerId: string;
  status: ErasureRequestRow['status'];
  attempts: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  lastError: string | null;
}

export interface CollectedCustomerPii {
  customerId: string;
  merchantId: string;
  emails: string[];
  names: string[];
  phones: string[];
  contacts: string[];
  addresses: string[];
  billingNames: string[];
  tokens: string[];
  references: string[];
  documentKeys: string[];
}

export function toPublicErasureRequest(row: ErasureRequestRow): PublicErasureRequest {
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

export function piiValuesFrom(collected: CollectedCustomerPii): string[] {
  return [...new Set([
    ...collected.emails, ...collected.names, ...collected.phones, ...collected.contacts,
    ...collected.addresses, ...collected.billingNames, ...collected.tokens, ...collected.references,
  ].filter((value) => value.length >= 3))].sort((left, right) => right.length - left.length);
}
