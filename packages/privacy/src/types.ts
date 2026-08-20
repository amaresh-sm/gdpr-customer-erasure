export interface SubjectContext {
  customerId: string;
  surrogateId: string;
  merchantId: string;
  sensitiveValues: string[];
}

export interface ErasureRequestRecord {
  id: string;
  merchant_id: string;
  customer_id: string;
  surrogate_id: string;
  status: 'pending' | 'processing' | 'failed' | 'completed';
  attempts: number;
  max_attempts: number;
  subject_context: SubjectContext;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}
