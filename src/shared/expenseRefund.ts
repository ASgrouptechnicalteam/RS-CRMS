import { z } from 'zod';

// Expense Refund Constants & Schemas
export const ExpenseRefundStatus = {
  PENDING: 'PENDING',
  ACCOUNTANT_APPROVED: 'ACCOUNTANT_APPROVED',
  MD_APPROVED: 'MD_APPROVED',
  REFUNDED: 'REFUNDED',
  REJECTED_BY_ACCOUNTANT: 'REJECTED_BY_ACCOUNTANT',
  REJECTED_BY_MD: 'REJECTED_BY_MD',
} as const;

export type ExpenseRefundStatusType =
  (typeof ExpenseRefundStatus)[keyof typeof ExpenseRefundStatus];

/** One fixed list for petty cash and expense refunds (owner decision 8), plus Other with a note. */
export const EXPENSE_CATEGORIES = [
  'Stationery',
  'Travel & conveyance',
  'Fuel',
  'Food & refreshments',
  'Courier & postage',
  'Printing',
  'Repairs & maintenance',
  'Cleaning & housekeeping',
  'Site expenses',
  'Utilities (power, water, internet)',
  'Other',
] as const;

export const ExpenseRefundCreateSchema = z.object({
  purpose: z.string().min(3, 'Purpose is required'),
  // Sent as form data (it can carry a photo), so the amount arrives as text.
  amount: z.coerce.number().positive('Amount must be greater than 0'),
  // Optional, so a request sent by an older copy of the app still goes through.
  category: z.enum(EXPENSE_CATEGORIES).optional(),
  spend_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick the date of the expense')
    .optional(),
  bill_no: z.string().trim().max(60, 'Bill number is too long').optional(),
});

export type ExpenseRefundCreateInput = z.infer<typeof ExpenseRefundCreateSchema>;

export const ExpenseRefundAccountantReviewSchema = z.object({
  decision: z.enum(['APPROVE', 'REJECT']),
  note: z.string().optional(),
});

export type ExpenseRefundAccountantReviewInput = z.infer<
  typeof ExpenseRefundAccountantReviewSchema
>;

export const ExpenseRefundMDReviewSchema = z.object({
  decision: z.enum(['APPROVE', 'REJECT']),
  note: z.string().optional(),
});

export type ExpenseRefundMDReviewInput = z.infer<typeof ExpenseRefundMDReviewSchema>;

export const ExpenseRefundMarkRefundedSchema = z.object({});

export type ExpenseRefundMarkRefundedInput = z.infer<typeof ExpenseRefundMarkRefundedSchema>;
