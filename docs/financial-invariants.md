# Financial invariants

1. Every ledger transaction has postings whose signed sum is zero.
2. Ledger postings are append-only.
3. A provider capture can create at most one payment ledger transaction.
4. A provider refund can create at most one refund ledger transaction.
5. Total successful refunds cannot exceed the captured amount.
6. Reconciliation reads immutable provider settlements and ledger postings.
7. Customer and projection lifecycle changes cannot alter ledger totals.
