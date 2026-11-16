import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';
import { notifyEmployee } from '../utils/notifyEmployee';
import { Roles } from '../shared';

/**
 * Asset management (2026-11-16). Tracked items (systems, phones, SIMs...) are
 * one per row and are given to a person; the rest (chairs, tables...) can be
 * one row with a quantity.
 */
export const ASSET_CATEGORIES = [
  { value: 'LAPTOP', label: 'Laptop', tracked: true },
  { value: 'DESKTOP', label: 'Desktop / system', tracked: true },
  { value: 'MONITOR', label: 'Monitor', tracked: true },
  { value: 'MOBILE', label: 'Mobile phone', tracked: true },
  { value: 'SIM', label: 'SIM card', tracked: true },
  { value: 'TABLET', label: 'Tablet', tracked: true },
  { value: 'PRINTER', label: 'Printer', tracked: true },
  { value: 'CHAIR', label: 'Chair', tracked: false },
  { value: 'TABLE', label: 'Table', tracked: false },
  { value: 'CUPBOARD', label: 'Cupboard', tracked: false },
  { value: 'AC', label: 'AC', tracked: false },
  { value: 'FAN', label: 'Fan', tracked: false },
  { value: 'CAMERA', label: 'Camera', tracked: false },
  { value: 'ROUTER', label: 'Router / network', tracked: false },
  { value: 'OTHER', label: 'Other', tracked: false },
] as const;

export const isTracked = (category: string) =>
  ASSET_CATEGORIES.some((c) => c.value === category && c.tracked);

export const ASSET_STATUSES = [
  { value: 'IN_USE', label: 'In use' },
  { value: 'IN_STOCK', label: 'In stock' },
  { value: 'UNDER_REPAIR', label: 'Under repair' },
  { value: 'LOST', label: 'Lost' },
  { value: 'SCRAPPED', label: 'Scrapped' },
] as const;

export const ASSET_CONDITIONS = ['GOOD', 'FAIR', 'DAMAGED'] as const;
export const SIM_OPERATORS = ['JIO', 'AIRTEL', 'VI', 'BSNL', 'OTHER'] as const;

const DAY = 864e5;
const istMidnight = (now: Date) =>
  new Date(`${new Date(now.getTime() + 5.5 * 3600e3).toISOString().slice(0, 10)}T00:00:00Z`);

/**
 * 09:30 IST daily: HR hears about SIM recharges / bills due in 3 days and
 * warranties ending in exactly 30 days (one message each per company).
 */
export async function assetReminderJob(now: Date = new Date()) {
  const today = istMidnight(now);
  const simDay = new Date(today.getTime() + 3 * DAY);
  const warrantyDay = new Date(today.getTime() + 30 * DAY);
  const live = { status: { notIn: ['SCRAPPED', 'LOST'] } };
  const [sims, warranties] = await Promise.all([
    prisma.asset.findMany({
      where: { ...live, category: 'SIM', sim_due_date: { gte: today, lte: simDay } },
      select: { company_id: true, sim_number: true, sim_operator: true, sim_due_date: true },
    }),
    prisma.asset.findMany({
      where: { ...live, warranty_until: warrantyDay },
      select: { company_id: true, asset_code: true, name: true },
    }),
  ]);
  const companies = [...new Set([...sims, ...warranties].map((x) => x.company_id))];
  let sent = 0;
  for (const companyId of companies) {
    const hr = await prisma.employee.findMany({
      where: {
        company_id: companyId,
        status: 'ACTIVE',
        roles: { some: { role: { name: Roles.HR_MANAGER } } },
      },
      select: { id: true },
    });
    if (!hr.length) continue;
    const s = sims.filter((x) => x.company_id === companyId);
    const w = warranties.filter((x) => x.company_id === companyId);
    if (s.length) {
      await notifyEmployee(
        hr.map((x) => x.id),
        {
          type: 'ASSET_SIM_DUE',
          title: `${s.length} SIM recharge${s.length === 1 ? '' : 's'} / bill${s.length === 1 ? '' : 's'} due`,
          message: s
            .map(
              (x) =>
                `${x.sim_number} (${x.sim_operator || 'SIM'}) on ${x.sim_due_date?.toISOString().slice(0, 10)}`,
            )
            .join(', '),
          link: '/assets?category=SIM',
        },
      );
      sent++;
    }
    if (w.length) {
      await notifyEmployee(
        hr.map((x) => x.id),
        {
          type: 'ASSET_WARRANTY_ENDING',
          title: `Warranty ends in 30 days: ${w.length} item${w.length === 1 ? '' : 's'}`,
          message: w.map((x) => `${x.asset_code} ${x.name}`).join(', '),
          link: '/assets',
        },
      );
      sent++;
    }
  }
  if (sent) logger.info(`[Assets] ${sent} reminder(s).`);
  return { sent, sims: sims.length, warranties: warranties.length };
}

/** What a leaver still holds, for the leaving form. */
export function assetsHeldBy(employeeId: number) {
  return prisma.asset.findMany({
    where: { holder_id: employeeId },
    select: {
      id: true,
      asset_code: true,
      name: true,
      category: true,
      serial_no: true,
      imei: true,
      sim_number: true,
    },
    orderBy: { asset_code: 'asc' },
  });
}
