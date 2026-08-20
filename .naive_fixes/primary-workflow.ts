import type { ErasureRequestRecord } from '../../../packages/privacy/src/types.js';
import { eraseCustomerRecords } from './handlers/customer-records.js';

export interface ErasureParticipant {
  name: string;
  run(request: ErasureRequestRecord): Promise<void>;
}

/** Deliberately incomplete mutation: only the primary customer-owned rows participate. */
export const PARTICIPANTS: readonly ErasureParticipant[] = [
  { name: 'customer-records', run: eraseCustomerRecords },
];
