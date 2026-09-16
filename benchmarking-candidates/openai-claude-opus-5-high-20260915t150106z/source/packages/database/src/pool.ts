import pg from 'pg';
import { config } from '../../config/src/index.js';

const { Pool } = pg;
export const pool = new Pool({ connectionString: config().POSTGRES_URL, max: 20, idleTimeoutMillis: 30_000 });

export async function transaction<T>(operation: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function advisoryLock(client: pg.PoolClient, key: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
}
