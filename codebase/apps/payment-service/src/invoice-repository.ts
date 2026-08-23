import type { PoolClient } from 'pg';

export interface InvoiceLine {
  description: string;
  quantity: number;
  unitAmount: number;
}

export class InvoiceRepository {
  async create(
    client: PoolClient,
    input: {
      invoiceId: string;
      merchantId: string;
      customerId: string;
      number: string;
      currency: string;
      subtotal: number;
      tax: number;
      total: number;
      customer: Record<string, unknown>;
      objectKey: string;
      checksum: string;
      lines: InvoiceLine[];
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO payments.invoices
       (id,merchant_id,customer_id,number,status,currency,subtotal,tax,total,billing_snapshot,object_key,issued_at)
       VALUES($1,$2,$3,$4,'issued',$5,$6,$7,$8,$9,$10,now())`,
      [
        input.invoiceId,
        input.merchantId,
        input.customerId,
        input.number,
        input.currency,
        input.subtotal,
        input.tax,
        input.total,
        input.customer,
        input.objectKey,
      ],
    );
    for (const line of input.lines) {
      await client.query(
        `INSERT INTO payments.invoice_lines(invoice_id,description,quantity,unit_amount,total)
         VALUES($1,$2,$3,$4,$5)`,
        [input.invoiceId, line.description, line.quantity, line.unitAmount, line.quantity * line.unitAmount],
      );
    }
    await client.query(
      `INSERT INTO operations.document_manifests
       (merchant_id,customer_id,object_key,document_type,content_type,checksum,metadata)
       VALUES($1,$2,$3,'invoice','application/json',$4,$5)`,
      [input.merchantId, input.customerId, input.objectKey, input.checksum, {
        invoiceId: input.invoiceId,
        number: input.number,
      }],
    );
  }
}
