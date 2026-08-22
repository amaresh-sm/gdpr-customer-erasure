import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { pool, transaction } from './pool.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = resolve(here, '../migrations');
await pool.query(`CREATE TABLE IF NOT EXISTS public.schema_migrations(
  name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
)`);
const files = (await readdir(migrationsDirectory)).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
for (const name of files) {
  const sql = await readFile(resolve(migrationsDirectory, name), 'utf8');
  const checksum = createHash('sha256').update(sql).digest('hex');
  await transaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('payflow-schema-migrations'))`);
    const applied = await client.query<{ checksum: string }>(`SELECT checksum FROM public.schema_migrations WHERE name=$1`, [name]);
    if (applied.rows[0]?.checksum === checksum) return;
    if (applied.rows[0]) throw new Error(`migration ${name} was modified after it was applied`);
    await client.query(sql);
    await client.query(`INSERT INTO public.schema_migrations(name,checksum) VALUES($1,$2)`, [name, checksum]);
  });
  console.log(JSON.stringify({ status: 'applied', migration: name }));
}
await pool.end();
console.log(JSON.stringify({ status: 'migrated', count: files.length }));
