import { createHash } from 'node:crypto';
import { pool, transaction } from '../packages/database/src/pool.js';
import { ensureBucket } from '../packages/storage/src/minio.js';

const MERCHANT_ID = '10000000-0000-4000-8000-000000000001';
const ADMIN_ID = '10000000-0000-4000-8000-000000000002';
const RAW_API_KEY = 'pf_test_benchmark_4ad1539de977';
const SECOND_MERCHANT_ID = '20000000-0000-4000-8000-000000000001';
const SECOND_ADMIN_ID = '20000000-0000-4000-8000-000000000002';
const SECOND_API_KEY = 'pf_test_bluebird_924bd90d2201';

await transaction(async (client) => {
  await client.query(
    `INSERT INTO platform.merchants(id,name,default_currency) VALUES($1,'Northstar Commerce','USD') ON CONFLICT(id) DO NOTHING`, [MERCHANT_ID],
  );
  await client.query(
    `INSERT INTO platform.merchants(id,name,default_currency) VALUES($1,'Bluebird Software','USD') ON CONFLICT(id) DO NOTHING`,
    [SECOND_MERCHANT_ID],
  );
  await client.query(
    `INSERT INTO platform.admins(id,merchant_id,email,display_name,role)
     VALUES($1,$2,'finance@bluebird.example','Bluebird Finance','owner') ON CONFLICT(id) DO NOTHING`,
    [SECOND_ADMIN_ID, SECOND_MERCHANT_ID],
  );
  await client.query(
    `INSERT INTO platform.api_keys(merchant_id,key_hash,label,scopes)
     VALUES($1,$2,'secondary tenant',ARRAY['customers:read','customers:write','payments:read','payments:write','reconciliation:read','reconciliation:write'])
     ON CONFLICT(key_hash) DO NOTHING`, [SECOND_MERCHANT_ID, createHash('sha256').update(SECOND_API_KEY).digest('hex')],
  );
  await client.query(
    `INSERT INTO platform.admins(id,merchant_id,email,display_name,role)
     VALUES($1,$2,'ops@northstar.example','Northstar Operations','owner') ON CONFLICT(id) DO NOTHING`, [ADMIN_ID, MERCHANT_ID],
  );
  await client.query(
    `INSERT INTO platform.api_keys(merchant_id,key_hash,label,scopes)
     VALUES($1,$2,'local benchmark',ARRAY['customers:read','customers:write','payments:read','payments:write','reconciliation:read','reconciliation:write'])
     ON CONFLICT(key_hash) DO NOTHING`, [MERCHANT_ID, createHash('sha256').update(RAW_API_KEY).digest('hex')],
  );
  for (const [code, name, accountType] of [
    ['PROCESSOR_CLEARING', 'Processor clearing', 'asset'], ['MERCHANT_PAYABLE', 'Merchant payable', 'liability'],
    ['PROCESSOR_FEES', 'Processor fees', 'expense'], ['BANK_CASH', 'Bank cash', 'asset'],
  ]) {
    for (const merchantId of [MERCHANT_ID, SECOND_MERCHANT_ID]) {
      await client.query(
        `INSERT INTO payments.ledger_accounts(merchant_id,code,name,account_type,currency)
         VALUES($1,$2,$3,$4,'USD') ON CONFLICT(merchant_id,code,currency) DO NOTHING`, [merchantId, code, name, accountType],
      );
    }
  }
});
await ensureBucket();
console.log(JSON.stringify({ tenants: [
  { merchantId: MERCHANT_ID, apiKey: RAW_API_KEY }, { merchantId: SECOND_MERCHANT_ID, apiKey: SECOND_API_KEY },
] }));
await pool.end();
