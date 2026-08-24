import type pg from 'pg';
import { pool } from '../../../packages/database/src/pool.js';
import type { CreateCustomer } from '../../../packages/contracts/src/domain.js';

export interface CustomerRow {
  id: string; merchant_id: string; external_reference: string; email: string; name: string;
  phone: string | null; status: string; metadata: Record<string, string>; version: number;
  created_at: Date; updated_at: Date;
}

export class CustomerRepository {
  async create(client: pg.PoolClient, merchantId: string, input: CreateCustomer): Promise<CustomerRow> {
    const result = await client.query<CustomerRow>(
      `INSERT INTO customers.customers(merchant_id,external_reference,email,name,phone,metadata)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
      [merchantId, input.externalReference, input.email, input.name, input.phone ?? null, input.metadata],
    );
    return result.rows[0]!;
  }

  async find(merchantId: string, customerId: string): Promise<CustomerRow | undefined> {
    const result = await pool.query<CustomerRow>(
      `SELECT * FROM customers.customers WHERE merchant_id=$1 AND id=$2`, [merchantId, customerId],
    );
    return result.rows[0];
  }

  async list(merchantId: string, cursor: string | undefined, limit: number): Promise<CustomerRow[]> {
    const result = await pool.query<CustomerRow>(
      `SELECT * FROM customers.customers WHERE merchant_id=$1 AND ($2::uuid IS NULL OR id>$2)
       ORDER BY id LIMIT $3`, [merchantId, cursor ?? null, limit],
    );
    return result.rows;
  }

  async findPaymentMethod(merchantId: string, customerId: string, paymentMethodId: string): Promise<Record<string, unknown> | undefined> {
    const result = await pool.query(
      `SELECT id,customer_id,type,brand,last4,billing_name,billing_address,status
       FROM customers.payment_method_refs WHERE merchant_id=$1 AND customer_id=$2 AND id=$3`,
      [merchantId, customerId, paymentMethodId],
    );
    return result.rows[0] as Record<string, unknown> | undefined;
  }

  async findPaymentMethodForProvider(merchantId: string, customerId: string, paymentMethodId: string): Promise<Record<string, unknown> | undefined> {
    const result = await pool.query(
      `SELECT id,customer_id,provider_token,status FROM customers.payment_method_refs
       WHERE merchant_id=$1 AND customer_id=$2 AND id=$3`,
      [merchantId, customerId, paymentMethodId],
    );
    return result.rows[0] as Record<string, unknown> | undefined;
  }

  async update(client: pg.PoolClient, merchantId: string, customerId: string,
               version: number, fields: { email?: string | undefined; name?: string | undefined; phone?: string | null | undefined }): Promise<CustomerRow | undefined> {
    const result = await client.query<CustomerRow>(
      `UPDATE customers.customers SET email=COALESCE($4,email),name=COALESCE($5,name),phone=COALESCE($6,phone),
       version=version+1,updated_at=now()
       WHERE merchant_id=$1 AND id=$2 AND version=$3 AND status='active' RETURNING *`,
      [merchantId, customerId, version, fields.email ?? null, fields.name ?? null, fields.phone ?? null],
    );
    return result.rows[0];
  }
}
