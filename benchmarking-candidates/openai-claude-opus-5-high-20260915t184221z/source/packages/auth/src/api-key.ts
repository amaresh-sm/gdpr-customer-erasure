import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { pool } from '../../database/src/pool.js';

export interface Principal { merchantId: string; apiKeyId: string; scopes: string[] }

export async function authenticate(request: FastifyRequest, requiredScope: string): Promise<Principal> {
  const raw = request.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!raw) throw Object.assign(new Error('missing API key'), { statusCode: 401 });
  const hash = createHash('sha256').update(raw).digest('hex');
  const result = await pool.query<{ id: string; merchant_id: string; scopes: string[] }>(
    `UPDATE platform.api_keys SET last_used_at=now()
     WHERE key_hash=$1 AND revoked_at IS NULL
     RETURNING id,merchant_id,scopes`, [hash],
  );
  const key = result.rows[0];
  if (!key || !key.scopes.includes(requiredScope)) {
    throw Object.assign(new Error('not authorized'), { statusCode: 403 });
  }
  return { merchantId: key.merchant_id, apiKeyId: key.id, scopes: key.scopes };
}
