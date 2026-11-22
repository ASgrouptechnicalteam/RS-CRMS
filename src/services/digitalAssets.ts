import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';
import { notifyEmployee } from '../utils/notifyEmployee';
import { Roles } from '../shared';

/**
 * Digital assets (owner, 2026-11-21): plans, subscriptions, domains, hosting, licences and
 * the like, with their renewal or expiry date, so nothing lapses by surprise. Logins and
 * passwords are never stored here: only where the account is held.
 */
const p = prisma as any;

export const DIGITAL_KINDS = [
  { value: 'DOMAIN', label: 'Domain name' },
  { value: 'HOSTING', label: 'Hosting or server' },
  { value: 'SOFTWARE', label: 'Software licence' },
  { value: 'SUBSCRIPTION', label: 'Subscription or plan' },
  { value: 'SSL', label: 'SSL certificate' },
  { value: 'EMAIL', label: 'Email or messaging service' },
  { value: 'OTHER', label: 'Other' },
] as const;

export const BILLING_CYCLES = [
  { value: 'MONTHLY', label: 'Monthly', months: 1 },
  { value: 'QUARTERLY', label: 'Every 3 months', months: 3 },
  { value: 'HALF_YEARLY', label: 'Every 6 months', months: 6 },
  { value: 'YEARLY', label: 'Yearly', months: 12 },
  { value: 'ONE_TIME', label: 'One time (expires)', months: 0 },
] as const;

const DAY = 864e5;
/** Today in India as a date at 00:00 UTC, the way date columns are compared. */
export const istToday = (now: Date = new Date()) =>
  new Date(`${new Date(now.getTime() + 5.5 * 3600e3).toISOString().slice(0, 10)}T00:00:00Z`);

export const daysLeft = (renewsOn: Date, now: Date = new Date()) =>
  Math.round((new Date(renewsOn).getTime() - istToday(now).getTime()) / DAY);

/** The next renewal date after a renewal, by billing cycle (one-time items do not renew). */
export function nextRenewal(renewsOn: Date, cycle: string, from: Date = istToday()): Date | null {
  const months = BILLING_CYCLES.find((c) => c.value === cycle)?.months || 0;
  if (!months) return null;
  const d = new Date(renewsOn);
  // One cycle on from the current date, then more while it is still not ahead (a late renewal).
  d.setUTCMonth(d.getUTCMonth() + months);
  for (let i = 0; i < 600 && d.getTime() <= from.getTime(); i++) d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

/** Reminder days: 30, 15, 7, 3, 1 and the day itself; then every 7 days while it is overdue. */
export const isReminderDay = (left: number) =>
  [30, 15, 7, 3, 1, 0].includes(left) || (left < 0 && Math.abs(left) % 7 === 0);

/**
 * 09:40 IST daily: whoever looks after an item, and the Admin and MD, hear about renewals
 * that are 30, 15, 7, 3, 1 or 0 days away, and about overdue ones every week.
 */
export async function digitalAssetReminderJob(now: Date = new Date()) {
  const horizon = new Date(istToday(now).getTime() + 31 * DAY);
  const due = await p.digitalAsset.findMany({
    where: { status: 'ACTIVE', renews_on: { lte: horizon } },
    select: {
      id: true,
      company_id: true,
      name: true,
      kind: true,
      renews_on: true,
      owner_id: true,
      auto_renew: true,
    },
  });
  const todays = due.filter((a: any) => isReminderDay(daysLeft(a.renews_on, now)));
  let sent = 0;
  for (const a of todays) {
    const left = daysLeft(a.renews_on, now);
    const admins = await p.employee.findMany({
      where: {
        company_id: a.company_id,
        status: 'ACTIVE',
        roles: { some: { role: { name: { in: [Roles.ADMIN, Roles.MD, Roles.TECHNICAL_MANAGER] } } } },
      },
      select: { id: true },
    });
    const ids = [...new Set<number>([...admins.map((x: { id: number }) => x.id), ...(a.owner_id ? [a.owner_id] : [])])];
    if (!ids.length) continue;
    const when =
      left > 0
        ? `ends in ${left} day${left === 1 ? '' : 's'}`
        : left === 0
          ? 'ends today'
          : `ended ${Math.abs(left)} days ago`;
    await notifyEmployee(ids, {
      type: 'DIGITAL_ASSET_RENEWAL',
      title: `${a.name} ${when}`,
      message: a.auto_renew
        ? 'It renews by itself. Check that the payment method is in order.'
        : 'Renew it, or it will stop working.',
      link: '/digital-assets',
    }).catch((err) => logger.error('[DigitalAssets] notify failed:', err));
    sent++;
  }
  if (sent) logger.info(`[DigitalAssets] ${sent} renewal reminder(s).`);
  return { sent, checked: due.length };
}
