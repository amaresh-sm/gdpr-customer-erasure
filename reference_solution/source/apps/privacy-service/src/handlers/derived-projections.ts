import { Redis } from 'ioredis';
import { config } from '../../../../packages/config/src/index.js';
import { containsSubjectValue, redactSubjectValue } from '../../../../packages/privacy/src/redact.js';
import type { ErasureRequestRecord, SubjectContext } from '../../../../packages/privacy/src/types.js';
import { CUSTOMER_INDEX, searchClient } from '../../../../packages/search/src/client.js';

/** Removes direct projections and sanitizes any merchant-level projection containing the subject. */
export async function eraseDerivedProjections(request: ErasureRequestRecord): Promise<void> {
  const context = request.subject_context as SubjectContext;
  const redis = new Redis(config().REDIS_URL);
  try {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', `merchant:${request.merchant_id}:*`, 'COUNT', 100);
      cursor = next;
      for (const key of keys) {
        if (key.includes(request.customer_id)) {
          await redis.del(key);
          continue;
        }
        const type = await redis.type(key);
        if (type === 'string') {
          const value = await redis.get(key);
          if (value && containsSubjectValue(value, context)) {
            await redis.set(key, redactSubjectValue(value, context));
          }
        } else if (type === 'hash') {
          const value = await redis.hgetall(key);
          for (const [field, item] of Object.entries(value)) {
            if (containsSubjectValue(item, context)) await redis.hset(key, field, redactSubjectValue(item, context));
          }
        }
      }
    } while (cursor !== '0');
  } finally {
    await redis.quit();
  }

  const id = `${request.merchant_id}:${request.customer_id}`;
  const exists = await searchClient.exists({ index: CUSTOMER_INDEX, id });
  if (exists.body) await searchClient.delete({ index: CUSTOMER_INDEX, id, refresh: true });
}
