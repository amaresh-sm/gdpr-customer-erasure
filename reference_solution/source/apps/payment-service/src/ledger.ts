import type pg from 'pg';

type Posting = { accountCode: string; direction: 'debit' | 'credit'; amount: number };

/** Writes one immutable, balanced journal entry and its postings. */
export async function postJournal(
  client: pg.PoolClient,
  input: {
    merchantId: string;
    referenceType: string;
    referenceId: string;
    description: string;
    currency: string;
    postings: Posting[];
  },
): Promise<string> {
  const debit = input.postings.filter((p) => p.direction === 'debit').reduce((sum, p) => sum + p.amount, 0);
  const credit = input.postings.filter((p) => p.direction === 'credit').reduce((sum, p) => sum + p.amount, 0);
  if (debit !== credit || debit <= 0) throw new Error('journal entry is not balanced');

  const entry = await client.query<{ id: string }>(
    `INSERT INTO payments.ledger_entries(merchant_id,reference_type,reference_id,description)
     VALUES($1,$2,$3,$4)
     ON CONFLICT(merchant_id,reference_type,reference_id) DO UPDATE SET description=EXCLUDED.description
     RETURNING id`,
    [input.merchantId, input.referenceType, input.referenceId, input.description],
  );
  const entryId = entry.rows[0]!.id;
  const existing = await client.query('SELECT 1 FROM payments.ledger_postings WHERE entry_id=$1 LIMIT 1', [entryId]);
  if (existing.rowCount) return entryId;

  for (const posting of input.postings) {
    const account = await client.query<{ id: string }>(
      `SELECT id FROM payments.ledger_accounts
       WHERE merchant_id=$1 AND code=$2 AND currency=$3`,
      [input.merchantId, posting.accountCode, input.currency],
    );
    if (!account.rows[0]) throw new Error(`missing ledger account ${posting.accountCode}`);
    await client.query(
      `INSERT INTO payments.ledger_postings(entry_id,account_id,direction,amount,currency)
       VALUES($1,$2,$3,$4,$5)`,
      [entryId, account.rows[0].id, posting.direction, posting.amount, input.currency],
    );
  }
  return entryId;
}
