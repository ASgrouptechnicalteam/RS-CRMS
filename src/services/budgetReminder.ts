import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';
import { notifyEmployee } from '../utils/notifyEmployee';
import { Roles } from '../shared';
import { getISTComponents } from '../utils/time';

/**
 * 10:00 IST every day; acts only on the 25th and the 1st (item 4, 2026-11-15):
 *  - 25th: each company's accountant, if next month's budget is not
 *    submitted (or approved) yet.
 *  - 1st: each company's MD, if this month's budget is not approved.
 */
const holders = (companyId: number, role: string) =>
  prisma.employee.findMany({
    where: { company_id: companyId, status: 'ACTIVE', roles: { some: { role: { name: role } } } },
    select: { id: true },
  });

export async function budgetReminderJob(now: Date = new Date()) {
  const today = getISTComponents(now).dateString;
  const [y, m, d] = today.split('-').map(Number);
  if (d !== 25 && d !== 1) return { sent: 0 };
  const month =
    d === 25
      ? m === 12
        ? `${y + 1}-01`
        : `${y}-${String(m + 1).padStart(2, '0')}`
      : today.slice(0, 7);
  const companies = await prisma.company.findMany({ select: { id: true } });
  let sent = 0;
  for (const c of companies) {
    const b = await prisma.monthlyBudget.findUnique({
      where: { company_id_month: { company_id: c.id, month } },
      select: { status: true },
    });
    if (d === 25 && (!b || ['DRAFT', 'REJECTED'].includes(b.status))) {
      const people = await holders(c.id, Roles.FINANCE);
      if (people.length) {
        await notifyEmployee(
          people.map((x) => x.id),
          {
            type: 'SYSTEM',
            title: `Budget for ${month} not submitted`,
            message: `Please submit the petty cash budget for ${month} to the MD.`,
            link: '/petty-cash',
          },
        );
        sent++;
      }
    }
    if (d === 1 && b?.status !== 'APPROVED') {
      const people = await holders(c.id, Roles.MD);
      if (people.length) {
        await notifyEmployee(
          people.map((x) => x.id),
          {
            type: 'SYSTEM',
            title: `Budget for ${month} not approved`,
            message: b
              ? `The budget for ${month} is ${b.status.toLowerCase()}.`
              : `No budget was submitted for ${month}.`,
            link: '/petty-cash',
          },
        );
        sent++;
      }
    }
  }
  logger.info(`[BudgetReminder] ${today}: ${sent} reminder(s).`);
  return { sent };
}
