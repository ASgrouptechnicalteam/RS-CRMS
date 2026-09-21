import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';

/**
 * Employee contact identity — phone and email must be unique per company.
 *
 * Employee.phone / Employee.email only carry an index, not a unique
 * constraint, so the onboarding form happily created several employees with
 * the same number (QA report 2026-09-14, item "duplicate employees"). The
 * check lives here so create, admin-update and self-update all apply the
 * same rule and produce the same message.
 *
 * Numbers are normalised to their 10-digit form before comparing and before
 * storing, because existing rows hold a mix of "+919876543210" and
 * "9876543210" and those are the same phone.
 */

type Db = Prisma.TransactionClient | typeof prisma;

/** "+91 98765 43210" / "09876543210" / "9876543210.0" -> "9876543210". Non-10-digit input is returned digits-only. */
export const normaliseEmployeePhone = (raw: string | null | undefined): string | null => {
  if (raw === null || raw === undefined) return raw ?? null;
  let digits = String(raw).trim().replace(/\.0+$/, '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return digits || null;
};

export const normaliseEmployeeEmail = (raw: string | null | undefined): string | null => {
  if (raw === null || raw === undefined) return raw ?? null;
  const v = String(raw).trim().toLowerCase();
  return v || null;
};

/** Every spelling under which a normalised phone may already be stored. */
const storedPhoneVariants = (phone: string) => [
  phone,
  `+91${phone}`,
  `91${phone}`,
  `0${phone}`,
  `+91 ${phone}`,
];

export interface EmployeeContactConflict {
  field: 'phone' | 'email';
  value: string;
  employee: { id: number; employee_code: string; full_name: string | null; status: string };
}

/**
 * Returns the first employee in `companyId` (other than `excludeEmployeeId`)
 * already using the given phone or email, or null when both are free.
 * Pass already-normalised values.
 */
export async function findEmployeeContactConflict(
  db: Db,
  args: {
    companyId: number;
    phone?: string | null;
    email?: string | null;
    excludeEmployeeId?: number;
  },
): Promise<EmployeeContactConflict | null> {
  const { companyId, phone, email, excludeEmployeeId } = args;
  const select = { id: true, employee_code: true, full_name: true, status: true } as const;
  const notSelf = excludeEmployeeId ? { id: { not: excludeEmployeeId } } : {};

  if (phone) {
    const hit = await db.employee.findFirst({
      where: { company_id: companyId, phone: { in: storedPhoneVariants(phone) }, ...notSelf },
      select,
    });
    if (hit) return { field: 'phone', value: phone, employee: hit };
  }
  if (email) {
    // MySQL's default collation compares case-insensitively; values are
    // lower-cased on write as well so the index stays useful.
    const hit = await db.employee.findFirst({
      where: { company_id: companyId, email, ...notSelf },
      select,
    });
    if (hit) return { field: 'email', value: email, employee: hit };
  }
  return null;
}

/** Human message for the 409 response. Names the holder so HR can act on it. */
export const employeeContactConflictMessage = (c: EmployeeContactConflict): string => {
  const who = `${c.employee.employee_code}${c.employee.full_name ? ` (${c.employee.full_name})` : ''}`;
  const label = c.field === 'phone' ? 'phone number' : 'email';
  const hint =
    c.employee.status === 'ACTIVE'
      ? `Use a different ${label} or update the existing record instead.`
      : `That employee is ${c.employee.status.toLowerCase()}; reactivate or edit that record instead of creating a new one.`;
  return `This ${label} (${c.value}) is already used by employee ${who}. ${hint}`;
};
