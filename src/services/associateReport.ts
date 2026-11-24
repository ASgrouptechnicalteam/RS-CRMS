import { prisma } from '../lib/prisma';
import { TokenPayload } from '../utils/jwt';
import { Roles } from '../shared';
import { getAccessibleCompanyIds } from '../authz/dataScope';
import { getISTComponents, getISTMidnightInstant } from '../utils/time';
import { associateScope, seesAllAssociates } from './associate.service';
import { associateWork, AssociateWork } from './associateWork';

/**
 * The associates report (Step 5, 2026-11-23): one week of the Channel Partner Managers' work with
 * associates, per manager, set against the week before, plus the two lists a manager acts on: associates
 * nobody has spoken to lately, and associates who joined a while ago but have brought no customer yet.
 * Built from the same numbers (associateWork) the daily report, targets and dashboards use.
 */
const p = prisma as any;
const DAY = 24 * 60 * 60 * 1000;
export const QUIET_DAYS = 14;
export const NO_LEAD_DAYS = 30;

const NUMBERS: (keyof AssociateWork)[] = [
  'calls',
  'spoke',
  'agreed',
  'enrolled',
  'leads',
  'visits_booked',
  'office_visits',
  'site_visits',
];

const empty = (): AssociateWork => ({
  calls: 0,
  new_calls: 0,
  follow_up_calls: 0,
  spoke: 0,
  agreed: 0,
  office_visits: 0,
  site_visits: 0,
  visits_booked: 0,
  enrolled: 0,
  leads: 0,
});
const add = (a: AssociateWork, b: AssociateWork): AssociateWork => {
  const out = { ...a };
  for (const k of NUMBERS) out[k] += b[k];
  out.new_calls += b.new_calls;
  out.follow_up_calls += b.follow_up_calls;
  return out;
};

/** Monday 00:00 IST to the next Monday, for the week containing `dateStr` (today when empty). */
export function weekRange(dateStr?: string) {
  const ref = /^\d{4}-\d{2}-\d{2}$/.test(dateStr || '')
    ? getISTMidnightInstant(dateStr!)
    : getISTMidnightInstant(getISTComponents(new Date()).dateString);
  const weekday = new Date(ref.getTime() + 5.5 * 60 * 60 * 1000).getUTCDay();
  const start = new Date(ref.getTime() - ((weekday + 6) % 7) * DAY);
  return { start, end: new Date(start.getTime() + 7 * DAY) };
}

export async function associateReport(user: TokenPayload, dateStr?: string, now = new Date()) {
  const cur = weekRange(dateStr);
  const prev = { start: new Date(cur.start.getTime() - 7 * DAY), end: cur.start };
  const scope = await associateScope(user);
  const companyIds = await getAccessibleCompanyIds(user);

  // Whose work is shown: every manager the person may see; a manager sees only their own.
  const cpms: { id: number; full_name: string | null; employee_code: string }[] = seesAllAssociates(
    user,
  )
    ? await p.employee.findMany({
        where: {
          company_id: { in: companyIds },
          status: 'ACTIVE',
          roles: { some: { role: { name: Roles.CHANNEL_PARTNER_MANAGER } } },
        },
        select: { id: true, full_name: true, employee_code: true },
        orderBy: { full_name: 'asc' },
      })
    : await p.employee.findMany({
        where: { id: user.employeeId },
        select: { id: true, full_name: true, employee_code: true },
      });

  const rows = await Promise.all(
    cpms.map(async (c) => {
      const [now_, before] = await Promise.all([
        associateWork(c.id, cur),
        associateWork(c.id, prev),
      ]);
      return {
        employee_id: c.id,
        name: c.full_name || c.employee_code,
        ...now_,
        prev_calls: before.calls,
      };
    }),
  );
  const totals = rows.reduce<AssociateWork>((s, r) => add(s, r), empty());
  const prevAll = await Promise.all(cpms.map((c) => associateWork(c.id, prev)));
  const prev_totals = prevAll.reduce<AssociateWork>((s, r) => add(s, r), empty());

  const quietBefore = new Date(now.getTime() - QUIET_DAYS * DAY);
  const noLeadBefore = new Date(now.getTime() - NO_LEAD_DAYS * DAY);
  const [quiet, quietTotal, noLeads, noLeadsTotal] = await Promise.all([
    p.associate.findMany({
      where: {
        AND: [
          scope,
          { pipeline: { notIn: ['LEFT'] } },
          { OR: [{ last_contacted_at: null }, { last_contacted_at: { lt: quietBefore } }] },
        ],
      },
      select: {
        id: true,
        full_name: true,
        phone: true,
        pipeline: true,
        last_contacted_at: true,
        created_at: true,
        owner: { select: { full_name: true } },
      },
      orderBy: [{ last_contacted_at: 'asc' }],
      take: 50,
    }),
    p.associate.count({
      where: {
        AND: [
          scope,
          { pipeline: { notIn: ['LEFT'] } },
          { OR: [{ last_contacted_at: null }, { last_contacted_at: { lt: quietBefore } }] },
        ],
      },
    }),
    p.associate.findMany({
      where: {
        AND: [
          scope,
          { pipeline: { in: ['ENROLLED', 'ACTIVE', 'DORMANT'] } },
          {
            OR: [
              { enrolled_at: { lte: noLeadBefore } },
              { enrolled_at: null, created_at: { lte: noLeadBefore } },
            ],
          },
          { leads: { none: {} } },
        ],
      },
      select: {
        id: true,
        full_name: true,
        phone: true,
        enrolled_at: true,
        created_at: true,
        owner: { select: { full_name: true } },
      },
      orderBy: { created_at: 'asc' },
      take: 50,
    }),
    p.associate.count({
      where: {
        AND: [
          scope,
          { pipeline: { in: ['ENROLLED', 'ACTIVE', 'DORMANT'] } },
          {
            OR: [
              { enrolled_at: { lte: noLeadBefore } },
              { enrolled_at: null, created_at: { lte: noLeadBefore } },
            ],
          },
          { leads: { none: {} } },
        ],
      },
    }),
  ]);
  const days = (d: Date | null) => (d ? Math.floor((now.getTime() - d.getTime()) / DAY) : null);

  return {
    week_start: getISTComponents(cur.start).dateString,
    week_end: getISTComponents(new Date(cur.end.getTime() - DAY)).dateString,
    quiet_days: QUIET_DAYS,
    no_lead_days: NO_LEAD_DAYS,
    rows,
    totals,
    prev_totals,
    quiet: {
      total: quietTotal,
      list: quiet.map((a: any) => ({
        id: a.id,
        name: a.full_name,
        phone: a.phone,
        pipeline: a.pipeline,
        owner: a.owner?.full_name ?? null,
        days_quiet: days(a.last_contacted_at),
      })),
    },
    joined_no_leads: {
      total: noLeadsTotal,
      list: noLeads.map((a: any) => ({
        id: a.id,
        name: a.full_name,
        phone: a.phone,
        owner: a.owner?.full_name ?? null,
        days_since_joined: days(a.enrolled_at || a.created_at),
      })),
    },
  };
}
