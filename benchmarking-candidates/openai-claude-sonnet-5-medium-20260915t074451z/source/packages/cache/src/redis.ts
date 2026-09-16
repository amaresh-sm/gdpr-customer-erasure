import { Redis } from 'ioredis';
import { config } from '../../config/src/index.js';

let client: Redis | undefined;

/** Lazily creates a shared Redis connection for services that only need occasional access. */
export function redisClient(): Redis {
  client ??= new Redis(config().REDIS_URL);
  return client;
}
