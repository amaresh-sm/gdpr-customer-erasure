import pino from 'pino';
import { config } from '../../config/src/index.js';

export const logger = pino({
  level: config().LOG_LEVEL,
  base: { service: process.env.SERVICE_NAME ?? 'payflow' },
  redact: ['req.headers.authorization', '*.apiKey', '*.providerToken'],
});
