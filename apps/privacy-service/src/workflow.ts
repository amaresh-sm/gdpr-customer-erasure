import type { ErasureRequestRecord } from '../../../packages/privacy/src/types.js';
import { eraseCustomerRecords } from './handlers/customer-records.js';
import { eraseDerivedProjections } from './handlers/derived-projections.js';
import { verifyCompletion } from './handlers/completion-verification.js';
import { anonymizeFinancialRecords } from './handlers/financial-records.js';
import { sanitizeObjectStorage } from './handlers/object-storage.js';
import { sanitizeOperationalRecords } from './handlers/operational-records.js';
import { quiesceSubject } from './handlers/quiescence.js';

export interface ErasureParticipant {
  name: string;
  run(request: ErasureRequestRecord): Promise<void>;
}

/** Explicit ownership registry for the durable erasure workflow. */
export const PARTICIPANTS: readonly ErasureParticipant[] = [
  { name: 'subject-quiescence', run: quiesceSubject },
  { name: 'financial-records', run: anonymizeFinancialRecords },
  { name: 'object-storage', run: sanitizeObjectStorage },
  { name: 'operational-records', run: sanitizeOperationalRecords },
  { name: 'derived-projections', run: eraseDerivedProjections },
  { name: 'customer-records', run: eraseCustomerRecords },
  { name: 'completion-verification', run: verifyCompletion },
];
