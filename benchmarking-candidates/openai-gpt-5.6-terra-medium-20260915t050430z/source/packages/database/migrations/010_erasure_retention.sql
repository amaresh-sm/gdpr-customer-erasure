ALTER TABLE payments.payment_intents ALTER COLUMN customer_id DROP NOT NULL;
ALTER TABLE payments.payment_intents ALTER COLUMN payment_method_id DROP NOT NULL;
ALTER TABLE payments.invoices ALTER COLUMN customer_id DROP NOT NULL;
