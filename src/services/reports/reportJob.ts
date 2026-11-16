import { prisma } from '../../lib/prisma';
import { logger } from '../../utils/logger';
import { notifyEmployee } from '../../utils/notifyEmployee';
import { withRoleAliases } from '../../shared';
import { TokenPayload } from '../../utils/jwt';
import { Period, periodContaining, previousPeriod } from '../counts/period';
import { defaultKind, getReport, resolveSubject, REPORT_KINDS } from './periodReports';

/**
 * "Your weekly / monthly report is ready" (replaces the old stub job).
 *
 * The host sleeps, so a fixed Monday 07:00 run was nearly always missed. Like
 * the reminders (jobs/reminders.ts) this runs on a sweep with a window: from
 * 07:00 IST on the Monday (or the 1st) until the end of the third day. A
 * database marker makes it happen once: a JOB row in ReportSnapshot per
 * company and period (its unique key also stops a second server running it
 * at the same moment), and one REPORT_READY notification per person and
 * period. It saves each person's report for the closed period on the way.
 */

const p = prisma;
const HOUR = 3600 * 1000;
export const REPORT_READY = 'REPORT_READY';

/** Periods whose notification window is open now. */
export function periodsDue(now: Date): Period[] {
  const out: Period[] = [];
  for (const type of ['WEEK', 'MONTH'] as const) {
    const cur = periodContaining(type, now);
    const since = now.getTime() - cur.start.getTime();
    if (since >= 7 * HOUR && since < 72 * HOUR) out.push(previousPeriod(cur));
  }
  return out;
}

const dayKey = (p: Period) => Number(p.startDate.replace(/-/g, ''));

async function claim(companyId: number, period: Period, now: Date) {
  const key = {
    company_id: companyId,
    scope: 'JOB',
    period_type: period.type,
    period_start: period.start,
  };
  try {
    await p.reportSnapshot.create({ data: { ...key, data: { job: 'report-ready' } } });
    return true;
  } catch (e: any) {
    if (e?.code !== 'P2002') throw e;
  }
  const row = await p.reportSnapshot.findUnique({
    where: { company_id_scope_period_type_period_start: key },
  });
  if (!row || row.notified_at) return false;
  // Another run started under 30 minutes ago and may still be going.
  if (now.getTime() - row.generated_at.getTime() < 30 * 60 * 1000) return false;
  // An earlier run stopped half-way: take it over (each person is still told once).
  const taken = await p.reportSnapshot.updateMany({
    where: { id: row.id, generated_at: row.generated_at },
    data: { generated_at: now },
  });
  return taken.count === 1;
}

async function runFor(period: Period, now: Date, companyIds?: number[]) {
  const people = await p.employee.findMany({
    where: {
      status: 'ACTIVE',
      deleted_at: null,
      roles: { none: { role: { is_invisible: true } } },
      ...(companyIds ? { company_id: { in: companyIds } } : {}),
    },
    select: { id: true, company_id: true, roles: { select: { role: { select: { name: true } } } } },
  });
  const byCompany = new Map<number, typeof people>();
  for (const e of people) byCompany.set(e.company_id, [...(byCompany.get(e.company_id) || []), e]);

  let sent = 0;
  for (const [companyId, staff] of byCompany) {
    if (!(await claim(companyId, period, now))) continue;
    const told = new Set(
      (
        await p.notification.findMany({
          where: {
            type: REPORT_READY,
            entity_type: `REPORT_${period.type}`,
            entity_id: dayKey(period),
            employee_id: { in: staff.map((s) => s.id) },
          },
          select: { employee_id: true },
        })
      ).map((n) => n.employee_id),
    );
    // One person at a time: the database pool is small.
    for (const e of staff) {
      try {
        const user = {
          employeeId: e.id,
          companyId,
          roles: withRoleAliases(e.roles.map((r) => r.role.name)),
          permissions: [],
        } as unknown as TokenPayload;
        const kind = defaultKind(user);
        await getReport(await resolveSubject(user, kind), period, now);
        if (told.has(e.id)) continue;
        const what = period.type === 'WEEK' ? 'weekly' : 'monthly';
        const title = `Your ${what} report is ready`;
        const message = `${REPORT_KINDS[kind]} for ${period.label}.`;
        await p.notification.create({
          data: {
            employee_id: e.id,
            type: REPORT_READY,
            title,
            message,
            entity_type: `REPORT_${period.type}`,
            entity_id: dayKey(period),
          },
        });
        await notifyEmployee(
          e.id,
          {
            type: REPORT_READY,
            title,
            message,
            link: `/reports?type=${period.type}&start=${period.startDate}`,
          },
          { skipDbNotification: true },
        );
        sent++;
      } catch (err) {
        logger.error({ err }, `[Reports] ${period.label} for employee ${e.id} failed`);
      }
    }
    await p.reportSnapshot.updateMany({
      where: {
        company_id: companyId,
        scope: 'JOB',
        period_type: period.type,
        period_start: period.start,
      },
      data: { notified_at: new Date() },
    });
  }
  return sent;
}

/** Runs every 30 minutes and once on start; does nothing outside the windows. */
export async function reportReadySweep(now: Date = new Date(), companyIds?: number[]) {
  let sent = 0;
  for (const period of periodsDue(now)) {
    sent += await runFor(period, now, companyIds);
  }
  if (sent) logger.info(`[Reports] "Report ready" sent to ${sent} people`);
  return sent;
}
