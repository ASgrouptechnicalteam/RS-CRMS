import { num } from '../utils/money';
import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';
import { notifyEmployee } from '../utils/notifyEmployee';
import { Roles } from '../shared';
import { getISTComponents, getISTMidnightInstant } from '../utils/time';

/**
 * 09:00 IST (item 6 #1, 2026-11-15): one message a day to each company's
 * accountant(s) with the installments overdue and due in the next 7 days,
 * and to each booking's owner with their own. Overdue is worked out on read
 * (no job marks it), so it is worked out here the same way: not received,
 * not cancelled, due before today.
 */
const OPEN = ['PENDING', 'PARTIALLY_RECEIVED', 'OVERDUE'];
const DAY_MS = 864e5;

const rupees = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;

export async function installmentDigestJob(now: Date = new Date()) {
  const today = getISTMidnightInstant(getISTComponents(now).dateString);
  const week = new Date(today.getTime() + 8 * DAY_MS); // through the 7th day ahead
  const rows = await prisma.installment.findMany({
    where: {
      status: { in: OPEN },
      due_date: { lt: week },
      booking: { status: { not: 'CANCELLED' } },
    },
    select: {
      expected_amount: true,
      received_amount: true,
      due_date: true,
      booking: { select: { company_id: true, assigned_employee_id: true } },
    },
  });
  if (rows.length === 0) return { companies: 0, owners: 0 };

  type Tally = { overdue: number; overdueAmt: number; soon: number; soonAmt: number };
  const add = (m: Map<number, Tally>, key: number, r: (typeof rows)[number]) => {
    const t = m.get(key) || { overdue: 0, overdueAmt: 0, soon: 0, soonAmt: 0 };
    const due = Math.max(num(r.expected_amount) - num(r.received_amount), 0);
    if (r.due_date < today) {
      t.overdue++;
      t.overdueAmt += due;
    } else {
      t.soon++;
      t.soonAmt += due;
    }
    m.set(key, t);
  };
  const byCompany = new Map<number, Tally>();
  const byOwner = new Map<number, Tally>();
  for (const r of rows) {
    add(byCompany, r.booking.company_id, r);
    if (r.booking.assigned_employee_id) add(byOwner, r.booking.assigned_employee_id, r);
  }
  const text = (t: Tally) =>
    [
      t.overdue ? `${t.overdue} overdue (${rupees(t.overdueAmt)})` : '',
      t.soon ? `${t.soon} due in the next 7 days (${rupees(t.soonAmt)})` : '',
    ]
      .filter(Boolean)
      .join(', ');

  for (const [companyId, t] of byCompany) {
    const accountants = await prisma.employee.findMany({
      where: {
        company_id: companyId,
        status: 'ACTIVE',
        roles: { some: { role: { name: Roles.FINANCE } } },
      },
      select: { id: true },
    });
    if (accountants.length) {
      await notifyEmployee(
        accountants.map((a) => a.id),
        {
          type: 'SYSTEM',
          title: t.overdue ? 'Installments overdue' : 'Installments due this week',
          message: `Customer installments: ${text(t)}.`,
          link: '/finance',
        },
      );
    }
  }
  for (const [ownerId, t] of byOwner) {
    await notifyEmployee(ownerId, {
      type: 'SYSTEM',
      title: t.overdue
        ? 'Your customers have installments overdue'
        : 'Your customers have installments due',
      message: `On your bookings: ${text(t)}. Remind the customers.`,
      link: '/bookings',
    });
  }
  logger.info(
    `[InstallmentDigest] ${rows.length} open installments; ${byCompany.size} companies, ${byOwner.size} booking owners told.`,
  );
  return { companies: byCompany.size, owners: byOwner.size };
}
