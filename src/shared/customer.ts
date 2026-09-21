import { z } from 'zod';
import { blankAsAbsent } from './zodHelpers';

// ─────────────────────────────────────────────────────────────
// CUSTOMER SCHEMAS
// ─────────────────────────────────────────────────────────────

export const CustomerCreateSchema = z.object({
  first_name: z.string().min(2),
  last_name: z.string().optional(),
  phone: z.string().min(10),
  email: blankAsAbsent(z.string().email().optional()),
  status: z.string().default('ACTIVE'),
  source: z.string().default('MANUAL_ENTRY'),
  assigned_to_id: z.number().optional(),
});

export const CustomerUpdateSchema = z.object({
  first_name: blankAsAbsent(z.string().min(2).optional()),
  last_name: z.string().optional(),
  phone: blankAsAbsent(z.string().min(10).optional()),
  email: blankAsAbsent(z.string().email().optional()),
  status: z.string().optional(),
});
