import { z } from 'zod';

export const createCustomerSchema = z.object({
  externalReference: z.string().min(1).max(100),
  email: z.string().email(),
  name: z.string().min(1).max(200),
  phone: z.string().min(5).max(40).optional(),
  metadata: z.record(z.string()).default({}),
});

export const createPaymentSchema = z.object({
  customerId: z.string().uuid(),
  amount: z.number().int().positive(),
  currency: z.string().length(3).transform((value) => value.toUpperCase()),
  paymentMethodId: z.string().uuid(),
  description: z.string().max(500).optional(),
});

export const createRefundSchema = z.object({
  amount: z.number().int().positive(),
  reason: z.string().min(1).max(200),
});

export type CreateCustomer = z.infer<typeof createCustomerSchema>;
export type CreatePayment = z.infer<typeof createPaymentSchema>;
export type CreateRefund = z.infer<typeof createRefundSchema>;
