import { prisma } from '../lib/prisma';
import { Roles } from '../shared';
import { TokenPayload } from '../utils/jwt';
import { getAccessibleCompanyIds } from '../authz/dataScope';
import { getDownstreamEmployeeIds } from '../utils/hierarchy';
import { calculatePerformanceScore } from './performance-metric';
import { WORK_LOG_ACTION, parseWorkLog, WorkLogEntry } from '../routes/workLog';
import { Period, periodContaining, previousPeriod } from './counts/period';
import { assistsFor, dealsIn, personStats, scoreInputs } from './counts/metrics';
import { GroupKey, Person, ROLE_GROUPS, groupOf, rankBy, staffOf } from './counts/people';

/**
 * Achievements: a plain scoreboard for one period (this month by default),
 * ranked inside role groups, ties sharing a rank. No points or badges
 * (owner, 2026-11-08). Everyone sees their own numbers and their team's;
 * the MD (and Admin, HR, the Marketing Director) see everyone.
 */

const p = prisma;

export const ACHIEVEMENT_PERIODS = {
  this_week: 'This week',
  this_month: 'This month',
  last_month: 'Last month',
  this_quarter: 'This quarter',
  all: 'All time',
} as const;
export type AchievementPeriod = keyof typeof ACHIEVEMENT_PERIODS;

export function achievementPeriod(key: string | undefined, now = new Date()): Period {
  switch (key) {
    case 'this_week':
      return periodContaining('WEEK', now);
    case 'last_month':
      return previousPeriod(periodContaining('MONTH', now));
    case 'this_quarter':
      return periodContaining('QUARTER', now);
    case 'all':
      return periodContaining('ALL', now);
    default:
      return periodContaining('MONTH', now);
  }
}

const COLUMNS: Record<GroupKey, { key: string; label: string; money?: boolean }[]> = {
  SALES: [
    { key: 'dealsClosed', label: 'Bookings confirmed' },
    { key: 'salesValue', label: 'Sales value', money: true },
    { key: 'siteVisitsExecuted', label: 'Visits done' },
    { key: 'siteVisitsScheduled', label: 'Visits booked' },
    { key: 'calls', label: 'Calls' },
    { key: 'connected', label: 'Connected' },
    { key: 'assistedConversions', label: 'Assisted bookings' },
  ],
  FIELD: [
    { key: 'siteVisitsExecuted', label: 'Visits done' },
    { key: 'propertiesVerified', label: 'Properties verified' },
    { key: 'score', label: 'Score' },
  ],
  CHANNEL: [
    { key: 'enrollments', label: 'Enrollments' },
    { key: 'associateBookings', label: 'Associate bookings' },
    { key: 'associateCalls', label: 'Associate calls' },
    { key: 'score', label: 'Score' },
  ],
  MARKETING: [
    { key: 'leadsWorked', label: 'Leads reached' },
    { key: 'leadsSourced', label: 'Leads added' },
    { key: 'score', label: 'Score' },
  ],
  OFFICE: [
    { key: 'score', label: 'Score' },
    { key: 'tasksDone', label: 'Tasks done' },
    { key: 'reportsSent', label: 'Daily reports' },
  ],
};

const RANK_KEYS: Record<GroupKey, string[]> = {
  SALES: ['dealsClosed', 'salesValue', 'siteVisitsExecuted', 'siteVisitsScheduled', 'connected'],
  FIELD: ['siteVisitsExecuted', 'propertiesVerified'],
  CHANNEL: ['enrollments', 'associateBookings', 'associateCalls'],
  MARKETING: ['leadsWorked', 'leadsSourced'],
  OFFICE: ['score'],
};

const ADVICE: Record<GroupKey, string> = {
  SALES:
    'Ranked by bookings the MD has confirmed, then sales value and site visits done. More connected calls lead to more visits.',
  FIELD:
    'Ranked by site visits you ran and marked done, then properties you verified. Accept visits quickly so they do not go to the MD.',
  CHANNEL:
    'Ranked by enrollments and associate bookings from your Work Log. Only work you log counts, so log each call and visit the same day.',
  MARKETING:
    'Ranked by leads you added that a telecaller has reached, then all leads you added by hand. Bulk uploads do not count.',
  OFFICE:
    'Ranked by your performance score: check in on time, send your daily report, finish your tasks.',
};

const ALL_VIEWERS: string[] = [Roles.MD, Roles.ADMIN, Roles.HR_MANAGER, Roles.MARKETING_DIRECTOR];

/** Who this viewer may see on the board: everyone, or themselves and their team. */
async function visiblePeople(user: TokenPayload, staff: Person[]) {
  if (user.roles.some((r) => ALL_VIEWERS.includes(r)))
    return { view: 'ALL' as const, people: staff };
  const me = staff.find((s) => s.id === user.employeeId);
  const down = new Set(await getDownstreamEmployeeIds(user.companyId, user.employeeId));
  // Colleagues with the same manager are the person's team.
  const ids = new Set<number>([user.employeeId, ...down]);
  if (me?.reporting_manager_id) {
    for (const s of staff) if (s.reporting_manager_id === me.reporting_manager_id) ids.add(s.id);
  }
  // A Sales Manager with no reporting lines set up still runs the sales team.
  if (user.roles.includes(Roles.SALES_MANAGER) && down.size === 0) {
    for (const s of staff) if (groupOf(s.roles) === 'SALES') ids.add(s.id);
  }
  return { view: 'TEAM' as const, people: staff.filter((s) => ids.has(s.id)) };
}

export async function buildAchievements(user: TokenPayload, periodKey?: string) {
  const period = achievementPeriod(periodKey);
  const range = { start: period.start, end: period.end, all: period.type === 'ALL' };
  const companyIds = await getAccessibleCompanyIds(user);
  const staff = await staffOf(companyIds, range.all ? undefined : range.start);
  const { view, people } = await visiblePeople(user, staff);
  const ids = people.map((x) => x.id);

  const deals = await dealsIn(companyIds, range);
  const [stats, assists] = await Promise.all([
    personStats(companyIds, ids, range, deals),
    assistsFor(deals),
  ]);
  const scoreIds = people.filter((x) => groupOf(x.roles) !== 'SALES').map((x) => x.id);
  const [inputs, verified, workLog] = await Promise.all([
    scoreInputs(scoreIds, range),
    p.property.groupBy({
      by: ['assigned_pm_id'],
      where: {
        assigned_pm_id: { in: ids },
        verified_by_pm_at: range.all ? { not: null } : { gte: range.start, lt: range.end },
      },
      _count: { _all: true },
    }),
    p.auditEvent.findMany({
      where: {
        actor_id: { in: people.filter((x) => groupOf(x.roles) === 'CHANNEL').map((x) => x.id) },
        action: WORK_LOG_ACTION,
        ...(range.all ? {} : { created_at: { gte: range.start, lt: range.end } }),
      },
      select: { id: true, actor_id: true, new_value: true, created_at: true },
    }),
  ]);
  const logBy = new Map<number, Record<string, number>>();
  for (const row of workLog) {
    const e = parseWorkLog(row) as WorkLogEntry | null;
    if (!e) continue;
    const m = logBy.get(row.actor_id) || {};
    m[e.kind] = (m[e.kind] || 0) + (e.count || 1);
    logBy.set(row.actor_id, m);
  }

  const rows = people.map((x) => {
    const s = stats.get(x.id)!;
    const inp = inputs.get(x.id);
    const log = logBy.get(x.id) || {};
    return {
      id: x.id,
      full_name: x.full_name,
      employee_code: x.employee_code,
      roles: x.roles,
      group: groupOf(x.roles),
      leadsSourced: s.leads_added,
      leadsWorked: s.leads_added_worked,
      calls: s.calls,
      connected: s.connected,
      siteVisitsScheduled: s.visits_booked,
      siteVisitsExecuted: s.visits_done,
      dealsClosed: s.deals,
      salesValue: s.sales_value,
      assistedConversions: assists.get(x.id) || 0,
      propertiesVerified: verified.find((v) => v.assigned_pm_id === x.id)?._count._all || 0,
      enrollments: log.ASSOCIATE_ENROLLMENT || 0,
      associateBookings: log.ASSOCIATE_BOOKING || 0,
      associateCalls: (log.ASSOCIATE_CALL || 0) + (log.ASSOCIATE_NEW_CALL || 0),
      score: inp ? calculatePerformanceScore(inp).score : null,
      tasksDone: inp?.completedTasks || 0,
      reportsSent: inp?.dailyReports || 0,
    };
  });
  type Row = (typeof rows)[number];

  const groups = ROLE_GROUPS.map((g) => {
    const members = rows.filter((r) => r.group === g.key);
    const ranked = rankBy(members, (r: Row) =>
      RANK_KEYS[g.key].map((k) => Number((r as any)[k] ?? 0)),
    );
    return {
      key: g.key,
      label: g.label,
      advice: ADVICE[g.key],
      columns: COLUMNS[g.key],
      rows: ranked,
    };
  }).filter((g) => g.rows.length > 0);

  const rankOf = new Map<number, number>();
  for (const g of groups) for (const r of g.rows) rankOf.set(r.id, r.rank);
  const leaderboard = rows.map((r) => ({ ...r, rank: rankOf.get(r.id) ?? null }));
  const mine = leaderboard.find((r) => r.id === user.employeeId) || null;

  return {
    period: {
      key: (periodKey && periodKey in ACHIEVEMENT_PERIODS
        ? periodKey
        : 'this_month') as AchievementPeriod,
      label: period.label,
      start: period.start,
      end: period.end,
    },
    periods: Object.entries(ACHIEVEMENT_PERIODS).map(([key, label]) => ({ key, label })),
    view,
    me: mine,
    my_group: mine?.group || null,
    groups,
    leaderboard,
  };
}
