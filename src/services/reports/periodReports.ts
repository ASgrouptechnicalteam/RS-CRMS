import { num } from '../../utils/money';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { Roles } from '../../shared';
import { TokenPayload } from '../../utils/jwt';
import { getAccessibleCompanyIds } from '../../authz/dataScope';
import { getDownstreamEmployeeIds, isManagerOf } from '../../utils/hierarchy';
import { CRM_ACTION } from '../../middleware/recordCrmAction';
import { WORK_LOG_ACTION, parseWorkLog } from '../../routes/workLog';
import { calculatePerformanceScore } from '../performance-metric';
import {
  chooseTargets,
  measureMetric,
  METRIC_LABELS,
  scaledTarget,
  TargetMetric,
  workShare,
} from '../targets.service';
import {
  Period,
  PeriodType,
  aboutDaysIn,
  isClosed,
  istDate,
  nextPeriod,
  periodOf,
  previousComparable,
} from '../counts/period';
import {
  Range,
  PersonStats,
  collectedIn,
  dealTotals,
  dealsIn,
  funnel,
  leadsAtRisk,
  outstanding,
  pct,
  personStats,
  scoreInputs,
  stageRank,
  visitCounts,
  visitDoneBy,
  visitDoneWhere,
  WAITING_PM,
} from '../counts/metrics';
import { associateWork } from '../associateWork';
import { Person, groupOf, nameOf, rankBy, staffOf } from '../counts/people';

/**
 * Weekly and monthly reports (owner point 4). One role-aware builder per
 * report kind; every number is what the CRM recorded, never typed. The open
 * period is computed live; a closed period is saved to ReportSnapshot the
 * first time it is read (or made by the Monday / 1st-of-month job), and that
 * saved copy is what everyone sees afterwards, so it never changes.
 * Each report: headline numbers against the previous period, tables,
 * exceptions (who or what needs a conversation) and a line about next period.
 */

const p = prisma;
/** Bump when a report's layout changes: closed periods saved with an older version are rebuilt. */
export const REPORT_VERSION = 2;

export const REPORT_KINDS = {
  COMPANY: 'Company (MD)',
  TECHNICAL: 'System (Technical Manager)',
  SALES: 'Sales team',
  PM: 'Project manager',
  CHANNEL: 'Channel partners',
  HR: 'HR',
  FINANCE: 'Finance',
  PERSONAL: 'My report',
} as const;
export type ReportKind = keyof typeof REPORT_KINDS;
const COMPANY_WIDE: ReportKind[] = ['COMPANY', 'TECHNICAL', 'HR', 'FINANCE'];

export type Format = 'number' | 'money' | 'percent' | 'text' | 'date';
export interface Headline {
  key: string;
  label: string;
  value: number;
  previous: number | null;
  format: Format;
  link?: string;
}
export interface Column {
  key: string;
  label: string;
  format?: Format;
}
export interface Table {
  key: string;
  title: string;
  hint?: string;
  columns: Column[];
  rows: Record<string, string | number | null>[];
  empty?: string;
}
export interface ReportDoc {
  version: number;
  kind: ReportKind;
  title: string;
  subject: { id: number; name: string } | null;
  period: { type: PeriodType; start: string; end: string; startDate: string; label: string };
  previous_label: string;
  headline: Headline[];
  tables: Table[];
  exceptions: { text: string; link?: string }[];
  next: string;
  generated_at: string;
}

export class ReportError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------- who may read what

const has = (u: TokenPayload, ...roles: string[]) => u.roles.some((r) => roles.includes(r));
const isTop = (u: TokenPayload) => has(u, Roles.MD, Roles.ADMIN);

/** The reports this person may open, their own default first. */
export function kindsFor(user: TokenPayload): ReportKind[] {
  const out: ReportKind[] = [];
  if (has(user, Roles.TECHNICAL_MANAGER)) out.push('TECHNICAL');
  if (isTop(user)) out.push('COMPANY', 'TECHNICAL', 'SALES', 'HR', 'FINANCE', 'PM', 'CHANNEL');
  if (has(user, Roles.SALES_MANAGER)) out.push('SALES');
  if (has(user, Roles.HR_MANAGER)) out.push('HR');
  if (has(user, Roles.FINANCE)) out.push('FINANCE');
  if (has(user, Roles.PROJECT_MANAGER)) out.push('PM');
  if (has(user, Roles.CHANNEL_PARTNER_MANAGER)) out.push('CHANNEL');
  out.push('PERSONAL');
  return [...new Set(out)];
}

interface Subject {
  kind: ReportKind;
  companyIds: number[];
  /** The company the saved copy belongs to. */
  companyId: number;
  scope: string;
  person: Person | null;
  /** SALES: the team's ids. */
  team?: Person[];
}

export async function resolveSubject(
  user: TokenPayload,
  kind: ReportKind,
  employeeId?: number,
): Promise<Subject> {
  if (!(kind in REPORT_KINDS)) throw new ReportError(400, 'Unknown report');
  if (!kindsFor(user).includes(kind)) throw new ReportError(403, 'You cannot open this report');
  const companyIds = (await getAccessibleCompanyIds(user)).sort((a, b) => a - b);
  const many = companyIds.length > 1 ? `@${companyIds.join(',')}` : '';

  if (COMPANY_WIDE.includes(kind)) {
    return { kind, companyIds, companyId: user.companyId, scope: `${kind}${many}`, person: null };
  }

  const staff = await staffOf(companyIds);
  if (kind === 'SALES') {
    // A Sales Manager's team (anyone reporting up to them); the MD may pick a
    // manager, or see all sales staff when none is picked.
    const managerId = isTop(user) ? employeeId : user.employeeId;
    const sales = staff.filter((s) => groupOf(s.roles) === 'SALES');
    if (!managerId) {
      return {
        kind,
        companyIds,
        companyId: user.companyId,
        scope: `SALES:0${many}`,
        person: null,
        team: sales,
      };
    }
    const manager = staff.find((s) => s.id === managerId);
    if (!manager) throw new ReportError(404, 'Employee not found');
    const down = new Set(await getDownstreamEmployeeIds(manager.company_id, manager.id));
    // No reporting lines set up yet: the whole sales team.
    const team = down.size
      ? sales.filter((s) => down.has(s.id))
      : sales.filter((s) => s.id !== manager.id);
    return {
      kind,
      companyIds,
      companyId: manager.company_id,
      scope: `SALES:${manager.id}${many}`,
      person: manager,
      team,
    };
  }

  const id = employeeId || user.employeeId;
  const person = staff.find((s) => s.id === id);
  if (!person) throw new ReportError(404, 'Employee not found');
  const allowed =
    id === user.employeeId ||
    isTop(user) ||
    (kind === 'PERSONAL' && has(user, Roles.HR_MANAGER)) ||
    (await isManagerOf(user.employeeId, id));
  if (!allowed) throw new ReportError(403, 'You can only open your own or your team’s report');
  return {
    kind,
    companyIds: [person.company_id],
    companyId: person.company_id,
    scope: `${kind}:${person.id}`,
    person,
  };
}

// ---------------------------------------------------------------- read or save

export function reportPeriod(type: string, startDate?: string, now: Date = new Date()): Period {
  if (type !== 'WEEK' && type !== 'MONTH') throw new ReportError(400, 'Choose a week or a month');
  const date = startDate && /^\d{4}-\d{2}-\d{2}$/.test(startDate) ? startDate : istDate(now);
  const period = periodOf(type, date);
  if (period.start > now) throw new ReportError(400, 'That period has not started yet');
  return period;
}

/** A report: live for the open period, the saved copy for a closed one. */
export async function getReport(subject: Subject, period: Period, now: Date = new Date()) {
  const closed = isClosed(period, now);
  const key = {
    company_id: subject.companyId,
    scope: subject.scope,
    period_type: period.type,
    period_start: period.start,
  };
  if (closed) {
    const saved = await p.reportSnapshot.findUnique({
      where: { company_id_scope_period_type_period_start: key },
    });
    if (saved && (saved.version ?? 1) >= REPORT_VERSION) {
      return { ...(saved.data as unknown as ReportDoc), live: false, saved_at: saved.generated_at };
    }
    // Saved with an older layout: build it again and keep the new copy.
    if (saved) {
      const fresh = await buildReport(subject, period, now);
      const row = await p.reportSnapshot.update({
        where: { company_id_scope_period_type_period_start: key },
        data: {
          version: REPORT_VERSION,
          generated_at: new Date(),
          data: fresh as unknown as Prisma.InputJsonValue,
        },
      });
      return { ...fresh, live: false, saved_at: row.generated_at };
    }
  }
  const doc = await buildReport(subject, period, now);
  if (!closed) return { ...doc, live: true, saved_at: null };
  try {
    const row = await p.reportSnapshot.create({
      data: { ...key, version: REPORT_VERSION, data: doc as unknown as Prisma.InputJsonValue },
    });
    return { ...doc, live: false, saved_at: row.generated_at };
  } catch (e: any) {
    // Someone else saved it a moment ago: theirs is the copy.
    if (e?.code !== 'P2002') throw e;
    const saved = await p.reportSnapshot.findUnique({
      where: { company_id_scope_period_type_period_start: key },
    });
    return { ...(saved!.data as unknown as ReportDoc), live: false, saved_at: saved!.generated_at };
  }
}

// ---------------------------------------------------------------- building blocks

interface Ctx {
  subject: Subject;
  period: Period;
  range: Range;
  prev: Range;
  prevLabel: string;
  now: Date;
  monthly: boolean;
}

const h = (
  key: string,
  label: string,
  value: number,
  previous: number | null,
  format: Format = 'number',
  link?: string,
): Headline => ({ key, label, value, previous, format, link });

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const money = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;
const daysOld = (d: Date | null, now: Date) =>
  d ? Math.max(0, Math.floor((now.getTime() - d.getTime()) / (24 * 3600 * 1000))) : null;

const SALES_COLUMNS: Column[] = [
  { key: 'name', label: 'Name', format: 'text' },
  { key: 'role', label: 'Role', format: 'text' },
  { key: 'calls', label: 'Calls' },
  { key: 'connected', label: 'Connected' },
  { key: 'qualified', label: 'Qualified' },
  { key: 'visits_booked', label: 'Visits booked' },
  { key: 'visits_done', label: 'Visits done' },
  { key: 'deals', label: 'Bookings' },
  { key: 'sales_value', label: 'Sales value', format: 'money' },
];

const roleLabel = (roles: string[]) => roles.filter((r) => r !== Roles.ADMIN).join(', ');

/** One row per person, ranked (ties share a rank). */
function salesRows(
  people: Person[],
  stats: Map<number, PersonStats>,
  target?: Map<number, number | null>,
) {
  return rankBy(
    people.map((x) => ({ x, s: stats.get(x.id)! })),
    (r) => [r.s.deals, r.s.sales_value, r.s.visits_done, r.s.visits_booked, r.s.connected],
  ).map(({ x, s, rank }) => ({
    rank,
    _employee: x.id,
    name: nameOf(x),
    role: roleLabel(x.roles),
    calls: s.calls,
    connected: s.connected,
    qualified: s.qualified,
    visits_booked: s.visits_booked,
    visits_done: s.visits_done,
    deals: s.deals,
    sales_value: s.sales_value,
    ...(target ? { target: target.get(x.id) ?? null } : {}),
  }));
}

const funnelTable = (f: Awaited<ReturnType<typeof funnel>>, hint: string): Table => ({
  key: 'funnel',
  title: 'Funnel',
  hint,
  columns: [
    { key: 'stage', label: 'Stage', format: 'text' },
    { key: 'count', label: 'Leads' },
    { key: 'conversion', label: 'From the stage before', format: 'percent' },
  ],
  rows: f.stages.map((s) => ({ stage: s.label, count: s.count, conversion: s.conversion })),
});

/**
 * Attainment of this period's targets (the same period type) per person, as a
 * percent of the target for the metric, using recorded numbers.
 */
export async function targetAttainment(
  companyIds: number[],
  period: Period,
  now: Date,
  people: Person[],
  stats: Map<number, PersonStats>,
) {
  const rows = await p.performanceTarget.findMany({
    where: { company_id: { in: companyIds }, is_active: true, period: period.type },
  });
  const known: Record<string, keyof PersonStats> = {
    CALLS: 'calls',
    VISITS_BOOKED: 'visits_booked',
    VISITS_COMPLETED: 'visits_done',
    BOOKINGS_CONFIRMED: 'deals',
  };
  // Only the four sales measures can be read from the counts; others are left out of the average.
  const done = (s: PersonStats, m: string) => (known[m] ? (s[known[m]] as number) : null);
  const out = new Map<number, number | null>();
  const detail: { id: number; metric: string; target: number; done: number }[] = [];
  const at = new Date(Math.min(period.end.getTime() - 1, now.getTime()));
  for (const x of people) {
    const mine = rows.filter(
      (t) =>
        t.employee_id === x.id || (!t.employee_id && t.role_name && x.roles.includes(t.role_name)),
    );
    const chosen = [...chooseTargets(mine, x.id, at).values()];
    if (chosen.length === 0) {
      out.set(x.id, null);
      continue;
    }
    const s = stats.get(x.id)!;
    const pcts: number[] = [];
    for (const t of chosen) {
      const d = done(s, t.metric);
      if (d === null) continue;
      detail.push({ id: x.id, metric: t.metric, target: t.value, done: d });
      pcts.push(t.value > 0 ? Math.min(100, (d / t.value) * 100) : 0);
    }
    out.set(x.id, pcts.length ? Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length) : null);
  }
  return { byPerson: out, detail };
}

/** Day-stamped night-job events (absence, missing report) per person in the range. */
async function stampedEvents(ids: number[], range: Range, actions: string[]) {
  if (ids.length === 0) return [];
  return p.auditEvent.groupBy({
    by: ['actor_id', 'action'],
    where: {
      actor_id: { in: ids },
      action: { in: actions },
      ...aboutDaysIn(range.start, range.end),
    },
    _count: { _all: true },
  });
}
const countFor = (
  rows: { actor_id: number; action: string; _count: { _all: number } }[],
  id: number,
  action: string,
) => rows.find((r) => r.actor_id === id && r.action === action)?._count._all || 0;

async function attendanceBy(ids: number[], range: Range) {
  const rows = ids.length
    ? await p.attendanceLog.groupBy({
        by: ['employee_id', 'status'],
        where: { employee_id: { in: ids }, check_in_at: { gte: range.start, lt: range.end } },
        _count: { _all: true },
      })
    : [];
  const of = (id: number, statuses: string[]) =>
    rows
      .filter((r) => r.employee_id === id && statuses.includes(r.status))
      .reduce((n, r) => n + r._count._all, 0);
  return {
    present: (id: number) =>
      of(id, ['PRESENT', 'APPROVED_LATE', 'APPROVED_HALF_DAY', 'LATE', 'HALF_DAY']),
    late: (id: number) => of(id, ['LATE']),
    halfDay: (id: number) => of(id, ['HALF_DAY']),
    total: (statuses: string[]) =>
      rows.filter((r) => statuses.includes(r.status)).reduce((n, r) => n + r._count._all, 0),
  };
}

async function leaveDays(ids: number[], range: Range) {
  if (ids.length === 0) return new Map<number, number>();
  const rows = await p.attendanceProposal.findMany({
    where: {
      employee_id: { in: ids },
      type: 'LEAVE',
      status: 'APPROVED',
      target_date: { gte: range.start, lt: range.end },
    },
    select: { employee_id: true, leave_type: true },
  });
  const out = new Map<number, number>();
  for (const r of rows)
    out.set(r.employee_id, (out.get(r.employee_id) || 0) + (r.leave_type === 'FULL_DAY' ? 1 : 0.5));
  return out;
}

// ---------------------------------------------------------------- report kinds

async function companyReport(ctx: Ctx): Promise<Partial<ReportDoc>> {
  const { companyIds } = ctx.subject;
  const staff = await staffOf(companyIds, ctx.range.start);
  const sales = staff.filter((s) => groupOf(s.roles) === 'SALES');
  const ids = staff.map((s) => s.id);
  const [deals, prevDeals, collected, prevCollected, f, prevF, visits, prevVisits] =
    await Promise.all([
      dealsIn(companyIds, ctx.range),
      dealsIn(companyIds, ctx.prev),
      collectedIn(companyIds, ctx.range),
      collectedIn(companyIds, ctx.prev),
      funnel(companyIds, ctx.range),
      funnel(companyIds, ctx.prev),
      visitCounts(companyIds, ctx.range, ctx.now),
      visitCounts(companyIds, ctx.prev, ctx.now),
    ]);
  const [stats, risk, events, att] = await Promise.all([
    personStats(
      companyIds,
      sales.map((s) => s.id),
      ctx.range,
      deals,
    ),
    leadsAtRisk(companyIds, ctx.now),
    stampedEvents(ids, ctx.range, ['UNINFORMED_ABSENT', 'MISSING_DAILY_REPORT']),
    attendanceBy(ids, ctx.range),
  ]);
  const { byPerson: target } = await targetAttainment(
    ctx.subject.companyIds,
    ctx.period,
    ctx.now,
    sales,
    stats,
  );
  const d = dealTotals(deals);
  const pd = dealTotals(prevDeals);

  const tables: Table[] = [
    funnelTable(f, "This period's new leads, by the furthest stage each reached"),
    {
      key: 'team',
      title: 'Sales team ranking',
      hint: 'Ranked by bookings confirmed, then sales value and site visits done. Ties share a rank.',
      columns: [
        { key: 'rank', label: '#' },
        ...SALES_COLUMNS,
        { key: 'target', label: 'Target %', format: 'percent' },
      ],
      rows: salesRows(sales, stats, target),
      empty: 'No sales staff.',
    },
    {
      key: 'attendance',
      title: 'Attendance exceptions',
      columns: [
        { key: 'name', label: 'Name', format: 'text' },
        { key: 'late', label: 'Late' },
        { key: 'half_day', label: 'Half day' },
        { key: 'absent', label: 'Absent (not informed)' },
        { key: 'reports_missed', label: 'Reports missed' },
      ],
      rows: staff
        .map((x) => ({
          _employee: x.id,
          name: nameOf(x),
          late: att.late(x.id),
          half_day: att.halfDay(x.id),
          absent: countFor(events, x.id, 'UNINFORMED_ABSENT'),
          reports_missed: countFor(events, x.id, 'MISSING_DAILY_REPORT'),
        }))
        .filter((r) => r.late + r.half_day + r.absent + r.reports_missed > 0)
        .sort(
          (a, b) => b.absent - a.absent || b.reports_missed - a.reports_missed || b.late - a.late,
        ),
      empty: 'Nobody was late or absent.',
    },
  ];

  if (ctx.monthly) {
    const byProject = new Map<string, { count: number; value: number }>();
    for (const x of deals) {
      const cur = byProject.get(x.project) || { count: 0, value: 0 };
      cur.count++;
      cur.value += x.agreed_price;
      byProject.set(x.project, cur);
    }
    const [sources, due, joiners, leavers, leave] = await Promise.all([
      p.lead.groupBy({
        by: ['source', 'status'],
        where: {
          company_id: { in: companyIds },
          created_at: { gte: ctx.range.start, lt: ctx.range.end },
        },
        _count: { _all: true },
      }),
      p.installment.aggregate({
        where: {
          booking: { company_id: { in: companyIds } },
          status: { not: 'CANCELLED' },
          due_date: { gte: ctx.range.start, lt: ctx.range.end },
        },
        _sum: { expected_amount: true },
      }),
      p.employee.count({
        where: {
          company_id: { in: companyIds },
          created_at: { gte: ctx.range.start, lt: ctx.range.end },
        },
      }),
      p.employee.count({
        where: {
          company_id: { in: companyIds },
          last_working_day: { gte: ctx.range.start, lt: ctx.range.end },
        },
      }),
      leaveDays(ids, ctx.range),
    ]);
    const bySource = new Map<string, { leads: number; booked: number }>();
    for (const s of sources) {
      const cur = bySource.get(s.source) || { leads: 0, booked: 0 };
      cur.leads += s._count._all;
      if (s.status === 'BOOKED') cur.booked += s._count._all;
      bySource.set(s.source, cur);
    }
    const ranked = salesRows(sales, stats, target);
    tables.push(
      {
        key: 'projects',
        title: 'Bookings by project',
        columns: [
          { key: 'project', label: 'Project', format: 'text' },
          { key: 'count', label: 'Bookings' },
          { key: 'value', label: 'Sales value', format: 'money' },
        ],
        rows: [...byProject.entries()]
          .map(([project, v]) => ({ project, ...v }))
          .sort((a, b) => b.value - a.value),
        empty: 'No bookings confirmed.',
      },
      {
        key: 'sources',
        title: 'Lead sources',
        columns: [
          { key: 'source', label: 'Source', format: 'text' },
          { key: 'leads', label: 'New leads' },
          { key: 'booked', label: 'Booked' },
          { key: 'rate', label: 'Conversion', format: 'percent' },
        ],
        rows: [...bySource.entries()]
          .map(([source, v]) => ({
            source: source.replace(/_/g, ' ').toLowerCase(),
            ...v,
            rate: pct(v.booked, v.leads),
          }))
          .sort((a, b) => b.leads - a.leads),
        empty: 'No new leads.',
      },
      {
        key: 'collections',
        title: 'Collections against installments due',
        columns: [
          { key: 'due', label: 'Due this month', format: 'money' },
          { key: 'collected', label: 'Collected', format: 'money' },
          { key: 'rate', label: 'Collected of due', format: 'percent' },
        ],
        rows: [
          {
            due: num(due._sum.expected_amount),
            collected: collected.amount,
            rate: pct(collected.amount, num(due._sum.expected_amount)),
          },
        ],
      },
      {
        key: 'top_bottom',
        title: 'Top and bottom of the sales ranking',
        columns: [
          { key: 'place', label: '', format: 'text' },
          { key: 'name', label: 'Name', format: 'text' },
          { key: 'deals', label: 'Bookings' },
          { key: 'visits_done', label: 'Visits done' },
          { key: 'target', label: 'Target %', format: 'percent' },
        ],
        rows: [
          ...ranked.slice(0, 3).map((r) => ({ ...r, place: `Top (#${r.rank})` })),
          ...ranked
            .slice(3)
            .slice(-3)
            .map((r) => ({ ...r, place: `Bottom (#${r.rank})` })),
        ],
        empty: 'No sales staff.',
      },
      {
        key: 'hr',
        title: 'People',
        columns: [
          { key: 'joiners', label: 'Joined' },
          { key: 'leavers', label: 'Left' },
          { key: 'leave_days', label: 'Leave days taken' },
        ],
        rows: [{ joiners, leavers, leave_days: [...leave.values()].reduce((a, b) => a + b, 0) }],
      },
    );
  }

  const absentTotal = events
    .filter((e) => e.action === 'UNINFORMED_ABSENT')
    .reduce((n, e) => n + e._count._all, 0);
  const missedTotal = events
    .filter((e) => e.action === 'MISSING_DAILY_REPORT')
    .reduce((n, e) => n + e._count._all, 0);
  const nextP = nextPeriod(ctx.period);
  const [nextVisits, nextDue] = await Promise.all([
    p.siteVisitBooking.count({
      where: {
        lead: { company_id: { in: companyIds } },
        scheduled_date: { gte: nextP.start, lt: nextP.end },
        status: { not: 'CANCELLED' },
      },
    }),
    p.installment.aggregate({
      where: {
        booking: { company_id: { in: companyIds } },
        status: { notIn: ['CANCELLED', 'RECEIVED'] },
        due_date: { gte: nextP.start, lt: nextP.end },
      },
      _sum: { expected_amount: true },
      _count: { _all: true },
    }),
  ]);
  return {
    headline: [
      h('new_leads', 'New leads', f.new_leads, prevF.new_leads, 'number', '/leads'),
      h('visits_done', 'Site visits done', visits.done, prevVisits.done, 'number', '/site-visits'),
      h('deals', 'Bookings confirmed', d.count, pd.count, 'number', '/bookings'),
      h('sales_value', 'Sales value', d.value, pd.value, 'money', '/bookings'),
      h('collected', 'Collected', collected.amount, prevCollected.amount, 'money', '/finance'),
      h('conversion', 'Lead conversion', f.rate, prevF.rate, 'percent', '/leads'),
    ],
    tables,
    exceptions: [
      risk.stale_5
        ? { text: `${plural(risk.stale_5, 'lead')} with no activity for 5+ days`, link: '/leads' }
        : null,
      risk.unassigned
        ? {
            text: `${plural(risk.unassigned, 'open lead')} with nobody assigned`,
            link: '/leads?status=NEW',
          }
        : null,
      visits.not_done
        ? {
            text: `${plural(visits.not_done, 'site visit')} whose time passed without being marked done`,
            link: '/site-visits',
          }
        : null,
      absentTotal
        ? { text: `${plural(absentTotal, 'uninformed absence')}`, link: '/hr-attendance' }
        : null,
      missedTotal
        ? { text: `${plural(missedTotal, 'daily report')} not sent`, link: '/hr-daily-reports' }
        : null,
    ].filter((x): x is { text: string; link: string } => !!x),
    next: `${nextP.label}: ${plural(nextVisits, 'site visit')} planned, ${plural(nextDue._count._all, 'installment')} due (${money(num(nextDue._sum.expected_amount))}).`,
  };
}

async function salesReport(ctx: Ctx): Promise<Partial<ReportDoc>> {
  const team = ctx.subject.team || [];
  const ids = team.map((s) => s.id);
  const { companyIds } = ctx.subject;
  const [stats, prevStats, f, risk] = await Promise.all([
    personStats(companyIds, ids, ctx.range),
    personStats(companyIds, ids, ctx.prev),
    funnel(companyIds, ctx.range, ids),
    leadsAtRisk(companyIds, ctx.now, ids),
  ]);
  const { byPerson: target } = await targetAttainment(
    ctx.subject.companyIds,
    ctx.period,
    ctx.now,
    team,
    stats,
  );
  const sum = (m: Map<number, PersonStats>, k: keyof PersonStats) =>
    [...m.values()].reduce((n, s) => n + s[k], 0);
  const byId = new Map(team.map((t) => [t.id, t]));
  const tables: Table[] = [
    {
      key: 'team',
      title: 'Team',
      hint: 'Ranked by bookings confirmed, then sales value and visits done. Ties share a rank.',
      columns: [
        { key: 'rank', label: '#' },
        ...SALES_COLUMNS,
        { key: 'target', label: 'Target %', format: 'percent' },
      ],
      rows: salesRows(team, stats, target),
      empty: 'Nobody in this team yet.',
    },
    funnelTable(f, "The team's new leads this period, by the furthest stage reached"),
    {
      key: 'stale',
      title: 'Leads with no activity',
      columns: [
        { key: 'name', label: 'Owner', format: 'text' },
        { key: 'stale_2', label: '2+ days' },
        { key: 'stale_5', label: '5+ days' },
      ],
      rows: risk.by_owner.map((r) => ({
        _employee: r.owner_id,
        name: byId.get(r.owner_id) ? nameOf(byId.get(r.owner_id)!) : `#${r.owner_id}`,
        stale_2: r.stale_2,
        stale_5: r.stale_5,
      })),
      empty: 'Every lead had activity in the last 2 days.',
    },
  ];
  if (ctx.monthly) {
    const leads = await p.lead.groupBy({
      by: ['source', 'status', 'exited_from_status'],
      where: {
        company_id: { in: companyIds },
        created_at: { gte: ctx.range.start, lt: ctx.range.end },
        OR: [
          { assigned_to_id: { in: ids }, handed_over_from_id: null },
          { handed_over_from_id: { in: ids } },
        ],
      },
      _count: { _all: true },
    });
    const src = new Map<string, { leads: number; booked: number }>();
    const drops = new Map<string, number>();
    for (const l of leads) {
      const c = src.get(l.source) || { leads: 0, booked: 0 };
      c.leads += l._count._all;
      if (stageRank(l.status) === 5) c.booked += l._count._all;
      src.set(l.source, c);
      if (l.status === 'DROPPED') {
        const k = (l.exited_from_status || 'Unknown').replace(/_/g, ' ').toLowerCase();
        drops.set(k, (drops.get(k) || 0) + l._count._all);
      }
    }
    const visitsDone = sum(stats, 'visits_done');
    tables.push(
      {
        key: 'sources',
        title: 'Conversion by source',
        columns: [
          { key: 'source', label: 'Source', format: 'text' },
          { key: 'leads', label: 'New leads' },
          { key: 'booked', label: 'Booked' },
          { key: 'rate', label: 'Conversion', format: 'percent' },
        ],
        rows: [...src.entries()].map(([s, v]) => ({
          source: s.replace(/_/g, ' ').toLowerCase(),
          ...v,
          rate: pct(v.booked, v.leads),
        })),
        empty: 'No new leads.',
      },
      {
        key: 'drops',
        title: 'Where leads were dropped',
        columns: [
          { key: 'stage', label: 'Dropped at', format: 'text' },
          { key: 'count', label: 'Leads' },
        ],
        rows: [...drops.entries()]
          .map(([stage, count]) => ({ stage, count }))
          .sort((a, b) => b.count - a.count),
        empty: 'No leads dropped.',
      },
      {
        key: 'visit_rate',
        title: 'Site visits to bookings',
        columns: [
          { key: 'visits', label: 'Visits done' },
          { key: 'deals', label: 'Bookings confirmed' },
          { key: 'rate', label: 'Bookings per visit', format: 'percent' },
        ],
        rows: [
          {
            visits: visitsDone,
            deals: sum(stats, 'deals'),
            rate: pct(sum(stats, 'deals'), visitsDone),
          },
        ],
      },
    );
  }
  const under = salesRows(team, stats, target).filter(
    (r) => typeof r.target === 'number' && r.target < 50,
  );
  return {
    headline: [
      h('calls', 'Calls', sum(stats, 'calls'), sum(prevStats, 'calls')),
      h('connected', 'Connected calls', sum(stats, 'connected'), sum(prevStats, 'connected')),
      h('qualified', 'Leads qualified', sum(stats, 'qualified'), sum(prevStats, 'qualified')),
      h(
        'visits_booked',
        'Visits booked',
        sum(stats, 'visits_booked'),
        sum(prevStats, 'visits_booked'),
        'number',
        '/site-visits',
      ),
      h(
        'visits_done',
        'Visits done',
        sum(stats, 'visits_done'),
        sum(prevStats, 'visits_done'),
        'number',
        '/site-visits',
      ),
      h(
        'deals',
        'Bookings confirmed',
        sum(stats, 'deals'),
        sum(prevStats, 'deals'),
        'number',
        '/bookings',
      ),
      h(
        'sales_value',
        'Sales value',
        sum(stats, 'sales_value'),
        sum(prevStats, 'sales_value'),
        'money',
        '/bookings',
      ),
    ],
    tables,
    exceptions: [
      ...under.map((r) => ({ text: `${r.name} is at ${r.target}% of target` })),
      ...(risk.stale_5
        ? [
            {
              text: `${plural(risk.stale_5, 'team lead')} with no activity for 5+ days`,
              link: '/leads',
            },
          ]
        : []),
    ],
    next: `Next ${ctx.period.type === 'WEEK' ? 'week' : 'month'}: work the ${plural(risk.stale_2, 'lead')} with no activity for 2+ days first.`,
  };
}

/**
 * One person's own targets for the period, judged the way the Targets page does: the same measures,
 * a week or month lowered for leave and days off. A daily target is shown as its daily goal times
 * the days the person could work, against what was done over the whole period.
 */
async function personTargets(ctx: Ctx, me: Person) {
  const [rows, emp] = await Promise.all([
    p.performanceTarget.findMany({
      where: {
        company_id: me.company_id,
        is_active: true,
        OR: [{ employee_id: me.id }, { employee_id: null, role_name: { in: me.roles } }],
      },
    }),
    p.employee.findUnique({
      where: { id: me.id },
      select: { id: true, company_id: true, weekly_off_day: true },
    }),
  ]);
  const at = new Date(Math.min(ctx.range.end.getTime() - 1, ctx.now.getTime()));
  const wanted = ctx.monthly ? ['DAY', 'WEEK', 'MONTH'] : ['DAY', 'WEEK'];
  const chosen = [...chooseTargets(rows, me.id, at).values()].filter((t) =>
    wanted.includes(t.period),
  );
  const share = emp ? await workShare(emp, ctx.range.start, ctx.range.end) : null;
  const order: Record<string, number> = { DAY: 0, WEEK: 1, MONTH: 2 };
  const out: { ord: number; period: string; metric: string; goal: number; done: number }[] = [];
  for (const t of chosen) {
    // A week target belongs to a week report and a month target to a month report: the other
    // period's target is shown only where it can be judged over this range.
    if (ctx.period.type === 'WEEK' && t.period === 'MONTH') continue;
    const done = await measureMetric(
      me.id,
      t.metric as TargetMetric,
      ctx.range.start,
      ctx.range.end,
    );
    const goal =
      t.period === 'DAY'
        ? t.value * Math.max(1, Math.round(share?.available ?? 1))
        : share && t.period === ctx.period.type
          ? scaledTarget(t.value, share.factor)
          : t.value;
    out.push({
      ord: order[t.period],
      period:
        t.period === 'DAY' ? 'Daily goal x working days' : t.period === 'WEEK' ? 'Week' : 'Month',
      metric: METRIC_LABELS[t.metric as TargetMetric] || t.metric,
      goal,
      done,
    });
  }
  return out.sort((a, b) => a.ord - b.ord || a.metric.localeCompare(b.metric));
}

async function personalReport(ctx: Ctx): Promise<Partial<ReportDoc>> {
  const me = ctx.subject.person!;
  const { companyIds } = ctx.subject;
  const [stats, prevStats, f, risk, inputs, reports, tasksOpen] = await Promise.all([
    personStats(companyIds, [me.id], ctx.range),
    personStats(companyIds, [me.id], ctx.prev),
    funnel(companyIds, ctx.range, [me.id]),
    leadsAtRisk(companyIds, ctx.now, [me.id]),
    scoreInputs([me.id], ctx.range, ctx.now),
    p.dailyReport.findMany({
      where: { employee_id: me.id, submitted_at: { gte: ctx.range.start, lt: ctx.range.end } },
      select: { submitted_at: true, target_met: true, below_target_reason: true, call_count: true },
      orderBy: { submitted_at: 'asc' },
    }),
    p.task.count({
      where: { assignee_id: me.id, status: { in: ['PENDING', 'IN_PROGRESS', 'OVERDUE'] } },
    }),
  ]);
  const s = stats.get(me.id)!;
  const ps = prevStats.get(me.id)!;
  const inp = inputs.get(me.id)!;
  const isPm = me.roles.includes(Roles.PROJECT_MANAGER);
  const [targets, leave, pmDone, pmVerified, pmFeedback] = await Promise.all([
    personTargets(ctx, me),
    leaveDays([me.id], ctx.range),
    isPm
      ? p.siteVisitBooking.count({ where: { ...visitDoneWhere(ctx.range), ...visitDoneBy(me.id) } })
      : 0,
    isPm
      ? p.property.count({
          where: {
            assigned_pm_id: me.id,
            verified_by_pm_at: { gte: ctx.range.start, lt: ctx.range.end },
          },
        })
      : 0,
    isPm
      ? p.siteVisitBooking.count({
          where: {
            project_manager_id: me.id,
            ...visitDoneWhere(ctx.range),
            feedback: { isNot: null },
          },
        })
      : 0,
  ]);
  const score = calculatePerformanceScore(inp).score;
  const isSales = groupOf(me.roles) === 'SALES';
  const tables: Table[] = [
    {
      key: 'targets',
      title: 'Targets',
      hint: 'A week or month goal is lowered for your leave and days off.',
      columns: [
        { key: 'metric', label: 'What', format: 'text' },
        { key: 'period', label: 'Goal for', format: 'text' },
        { key: 'goal', label: 'Goal' },
        { key: 'done', label: 'Done' },
        { key: 'percent', label: 'Reached', format: 'percent' },
      ],
      rows: targets.map((t) => ({
        metric: t.metric,
        period: t.period,
        goal: t.goal,
        done: t.done,
        percent: t.goal ? Math.round((t.done / t.goal) * 100) : 0,
      })),
      empty: 'No targets are set for you.',
    },
    {
      key: 'attendance',
      title: 'Attendance',
      columns: [
        { key: 'present', label: 'Days present' },
        { key: 'late', label: 'Late' },
        { key: 'half', label: 'Half days' },
        { key: 'leave', label: 'Leave days' },
        { key: 'absent', label: 'Absent without telling' },
        { key: 'auto', label: 'Forgot to check out' },
      ],
      rows: [
        {
          present: inp.presentCount,
          late: inp.lateCount,
          half: inp.halfDayCount,
          leave: leave.get(me.id) || 0,
          absent: inp.uninformedAbsentEvents,
          auto: inp.midnightAutoCheckoutEvents,
        },
      ],
    },
    {
      key: 'days',
      title: 'Daily reports',
      columns: [
        { key: 'date', label: 'Day', format: 'text' },
        { key: 'calls', label: 'Calls' },
        { key: 'met', label: 'Target', format: 'text' },
        { key: 'reason', label: 'Reason you gave', format: 'text' },
      ],
      rows: reports.map((r) => ({
        date: istDate(r.submitted_at),
        calls: r.call_count ?? 0,
        met: r.target_met ? 'Met' : 'Below',
        reason: r.below_target_reason || '',
      })),
      empty: 'No daily report was sent in this period.',
    },
  ];
  if (isPm)
    tables.push({
      key: 'pm_visits',
      title: 'Site visits I ran',
      columns: [
        { key: 'done', label: 'Visits done' },
        { key: 'feedback', label: 'With customer feedback' },
        { key: 'verified', label: 'Properties verified' },
      ],
      rows: [{ done: pmDone, feedback: pmFeedback, verified: pmVerified }],
    });
  if (isSales)
    tables.push(funnelTable(f, 'Your new leads this period, by the furthest stage reached'));
  if (ctx.monthly) {
    const calls = await p.leadActivity.findMany({
      where: {
        actor_id: me.id,
        activity_type: 'CALL_LOGGED',
        created_at: { gte: ctx.range.start, lt: ctx.range.end },
      },
      select: { created_at: true },
    });
    const perDay = new Map<string, number>();
    for (const c of calls)
      perDay.set(istDate(c.created_at), (perDay.get(istDate(c.created_at)) || 0) + 1);
    const best = [...perDay.entries()].sort((a, b) => b[1] - a[1])[0];
    tables.push({
      key: 'month',
      title: 'My month',
      columns: [
        { key: 'best_day', label: 'Best calling day', format: 'text' },
        { key: 'best_calls', label: 'Calls that day' },
        { key: 'score', label: 'Performance score' },
        { key: 'conversion', label: 'My lead conversion', format: 'percent' },
      ],
      rows: [{ best_day: best?.[0] || '', best_calls: best?.[1] || 0, score, conversion: f.rate }],
    });
  }
  const headline = [
    ...(isSales
      ? [
          h('calls', 'Calls', s.calls, ps.calls),
          h('connected', 'Connected calls', s.connected, ps.connected),
          h('qualified', 'Leads qualified', s.qualified, ps.qualified),
          h(
            'visits_booked',
            'Visits booked',
            s.visits_booked,
            ps.visits_booked,
            'number',
            '/site-visits',
          ),
        ]
      : [
          h(
            'leads_added',
            'Leads added by hand',
            s.leads_added,
            ps.leads_added,
            'number',
            '/leads',
          ),
        ]),
    h(
      'visits_done',
      'Visits done',
      isPm ? pmDone : s.visits_done,
      isPm ? null : ps.visits_done,
      'number',
      '/site-visits',
    ),
    h('deals', 'Bookings confirmed', s.deals, ps.deals, 'number', '/bookings'),
    h('sales_value', 'Sales value', s.sales_value, ps.sales_value, 'money', '/bookings'),
    h('reports', 'Daily reports sent', reports.length, null, 'number', '/my-day'),
    h('tasks', 'Tasks done', inp.completedTasks, null, 'number', '/tasks'),
    h('present', 'Days present', inp.presentCount, null),
  ];
  headline.push(h('score', 'Performance score', score, null, 'number', '/my-performance'));
  const below = reports.filter((r) => !r.target_met).length;
  return {
    headline,
    tables,
    exceptions: [
      ...(risk.stale_5
        ? [
            {
              text: `${plural(risk.stale_5, 'lead')} of yours with no activity for 5+ days`,
              link: '/leads',
            },
          ]
        : []),
      ...(below ? [{ text: `${plural(below, 'day')} below target`, link: '/my-day' }] : []),
      ...(inp.uninformedAbsentEvents
        ? [
            {
              text: `${plural(inp.uninformedAbsentEvents, 'day')} absent without telling`,
              link: '/my-day',
            },
          ]
        : []),
      ...(inp.lateCount + inp.halfDayCount
        ? [{ text: `${plural(inp.lateCount + inp.halfDayCount, 'late or half-day check-in')}` }]
        : []),
      ...(inp.midnightAutoCheckoutEvents
        ? [
            {
              text: `${plural(inp.midnightAutoCheckoutEvents, 'day')} you forgot to check out`,
              link: '/my-day',
            },
          ]
        : []),
      ...(inputs.get(me.id)!.missingDailyReportEvents
        ? [
            {
              text: `${plural(inputs.get(me.id)!.missingDailyReportEvents, 'daily report')} not sent`,
              link: '/my-day',
            },
          ]
        : []),
    ],
    next: `Next: ${plural(tasksOpen, 'open task')}${risk.stale_2 ? `, ${plural(risk.stale_2, 'lead')} to follow up` : ''}.`,
  };
}

async function pmReport(ctx: Ctx): Promise<Partial<ReportDoc>> {
  const me = ctx.subject.person!;
  const r = ctx.range;
  const mine = { project_manager_id: me.id };
  const [byStatus, done, prevDone, verified, prevVerified, withFeedback, escalated, waiting] =
    await Promise.all([
      p.siteVisitBooking.groupBy({
        by: ['status'],
        where: { ...mine, scheduled_date: { gte: r.start, lt: r.end } },
        _count: { _all: true },
      }),
      p.siteVisitBooking.count({ where: { ...visitDoneWhere(r), ...visitDoneBy(me.id) } }),
      p.siteVisitBooking.count({ where: { ...visitDoneWhere(ctx.prev), ...visitDoneBy(me.id) } }),
      p.property.count({
        where: { assigned_pm_id: me.id, verified_by_pm_at: { gte: r.start, lt: r.end } },
      }),
      p.property.count({
        where: {
          assigned_pm_id: me.id,
          verified_by_pm_at: { gte: ctx.prev.start, lt: ctx.prev.end },
        },
      }),
      p.siteVisitBooking.count({
        where: { ...mine, ...visitDoneWhere(r), feedback: { isNot: null } },
      }),
      p.siteVisitEscalation.count({
        where: { booking: mine, managing_director_notified_at: { gte: r.start, lt: r.end } },
      }),
      p.siteVisitBooking.findMany({
        where: { ...mine, status: { in: [...WAITING_PM] } },
        select: { booking_code: true, scheduled_date: true, created_at: true },
        orderBy: { created_at: 'asc' },
        take: 20,
      }),
    ]);
  const n = (sts: string[]) =>
    byStatus.filter((b) => sts.includes(b.status)).reduce((a, b) => a + b._count._all, 0);
  const planned = n(byStatus.map((b) => b.status).filter((x) => x !== 'CANCELLED'));
  const notDone = n([
    'REQUESTED',
    'PENDING_ACCEPTANCE',
    'REASSIGNED',
    'ACCEPTED',
    'CONFIRMED',
    'PENDING_CUSTOMER_RECONFIRMATION',
    'PENDING_PM_RECONFIRMATION',
    'ACTIVE',
    'ON_HOLD',
  ]);
  const tables: Table[] = [
    {
      key: 'visits',
      title: 'My visits in this period (by visit date)',
      columns: [
        { key: 'status', label: 'Status', format: 'text' },
        { key: 'count', label: 'Visits' },
      ],
      rows: byStatus.map((b) => ({
        status: b.status.replace(/_/g, ' ').toLowerCase(),
        count: b._count._all,
      })),
      empty: 'No visits.',
    },
    {
      key: 'waiting',
      title: 'Waiting for you to accept',
      columns: [
        { key: 'code', label: 'Visit', format: 'text' },
        { key: 'date', label: 'Visit date', format: 'text' },
        { key: 'age', label: 'Waiting (days)' },
      ],
      rows: waiting.map((w) => ({
        code: w.booking_code,
        date: istDate(w.scheduled_date),
        age: daysOld(w.created_at, ctx.now),
      })),
      empty: 'Nothing waiting.',
    },
  ];
  if (ctx.monthly) {
    tables.push({
      key: 'feedback',
      title: 'Visit to feedback',
      columns: [
        { key: 'done', label: 'Visits done' },
        { key: 'feedback', label: 'With feedback' },
        { key: 'rate', label: 'Rate', format: 'percent' },
      ],
      rows: [{ done, feedback: withFeedback, rate: pct(withFeedback, done) }],
    });
  }
  return {
    headline: [
      h('planned', 'Visits planned', planned, null, 'number', '/site-visits'),
      h('done', 'Visits done', done, prevDone, 'number', '/site-visits'),
      h('verified', 'Properties verified', verified, prevVerified, 'number', '/properties'),
      h('escalated', 'Visits sent to the MD (slow reply)', escalated, null),
    ],
    tables,
    exceptions: [
      ...(waiting.length
        ? [
            {
              text: `${plural(waiting.length, 'visit')} still waiting for you to accept`,
              link: '/site-visits',
            },
          ]
        : []),
      ...(notDone && isClosed(ctx.period, ctx.now)
        ? [
            {
              text: `${plural(notDone, 'visit')} not marked done or cancelled`,
              link: '/site-visits',
            },
          ]
        : []),
    ],
    next: 'Next: accept every new visit within the day so none goes to the MD.',
  };
}

async function channelReport(ctx: Ctx): Promise<Partial<ReportDoc>> {
  const me = ctx.subject.person!;
  const since = new Date(ctx.now.getTime() - 120 * 24 * 3600 * 1000);
  const [rows, now, before, followUps, owned] = await Promise.all([
    // Older Work Log entries (visits, prospects, bookings are still logged there).
    p.auditEvent.findMany({
      where: {
        actor_id: me.id,
        action: WORK_LOG_ACTION,
        created_at: { gte: new Date(Math.min(since.getTime(), ctx.prev.start.getTime())) },
      },
      select: { id: true, new_value: true, created_at: true },
    }),
    // What the Associates page recorded (calls, agreements, office visits, enrolments, leads).
    associateWork(me.id, ctx.range),
    associateWork(me.id, ctx.prev),
    p.associateFollowUp.findMany({
      where: { employee_id: me.id, created_at: { gte: ctx.range.start, lt: ctx.range.end } },
      select: { channel: true, outcome: true, associate: { select: { full_name: true } } },
    }),
    p.associate.findMany({
      where: { owner_cpm_id: me.id, pipeline: { notIn: ['LEFT'] } },
      select: { full_name: true, last_contacted_at: true },
    }),
  ]);
  const entries = rows
    .map(parseWorkLog)
    .filter((e): e is NonNullable<ReturnType<typeof parseWorkLog>> => !!e);
  const logged = (kinds: string[], r: Range) =>
    entries
      .filter((e) => kinds.includes(e.kind) && e.at >= r.start && e.at < r.end)
      .reduce((n, e) => n + (e.count || 1), 0);
  // One number per line: the Associates page record plus anything logged in the Work Log.
  const KINDS: [string, string, string[], (w: typeof now) => number][] = [
    ['calls', 'Associate calls', ['ASSOCIATE_CALL', 'ASSOCIATE_NEW_CALL'], (w) => w.calls],
    ['agreed', 'Agreed to work with us', [], (w) => w.agreed],
    ['prospects', 'New prospects', ['ASSOCIATE_PROSPECT'], () => 0],
    ['office', 'Office visits', ['ASSOCIATE_OFFICE_VISIT'], (w) => w.office_visits],
    ['enrollments', 'Enrollments', ['ASSOCIATE_ENROLLMENT'], (w) => w.enrolled],
    ['site', 'Associate site visits', ['ASSOCIATE_SITE_VISIT'], (w) => w.site_visits],
    ['leads', 'Leads from associates', [], (w) => w.leads],
    ['visits_booked', 'Site visits booked for their customers', [], (w) => w.visits_booked],
    ['bookings', 'Associate bookings', ['ASSOCIATE_BOOKING'], () => 0],
  ];
  const value = (kinds: string[], pick: (w: typeof now) => number, r: Range, w: typeof now) =>
    logged(kinds, r) + pick(w);

  // Per associate: Work Log names plus the associates followed up on the Associates page.
  const last = new Map<string, Date>();
  const per = new Map<string, Record<string, number>>();
  for (const e of entries) {
    const name = e.associate_name || e.associate_id;
    if (!name || !e.kind.startsWith('ASSOCIATE_')) continue;
    if (!last.get(name) || last.get(name)! < e.at) last.set(name, e.at);
    if (e.at >= ctx.range.start && e.at < ctx.range.end) {
      const m = per.get(name) || {};
      m[e.kind] = (m[e.kind] || 0) + (e.count || 1);
      per.set(name, m);
    }
  }
  for (const a of owned) {
    if (
      a.last_contacted_at &&
      (!last.get(a.full_name) || last.get(a.full_name)! < a.last_contacted_at)
    )
      last.set(a.full_name, a.last_contacted_at);
    if (!a.last_contacted_at && !last.has(a.full_name)) last.set(a.full_name, new Date(0));
  }
  const CHANNEL_KIND: Record<string, string> = {
    CALL: 'ASSOCIATE_CALL',
    OFFICE_VISIT: 'ASSOCIATE_OFFICE_VISIT',
    SITE_VISIT: 'ASSOCIATE_SITE_VISIT',
  };
  for (const f of followUps) {
    const name = f.associate?.full_name;
    if (!name) continue;
    const m = per.get(name) || {};
    const kind = CHANNEL_KIND[f.channel];
    if (kind) m[kind] = (m[kind] || 0) + 1;
    if (f.outcome === 'AGREED') m.AGREED = (m.AGREED || 0) + 1;
    per.set(name, m);
  }
  const quiet = [...last.entries()].filter(
    ([, at]) => ctx.now.getTime() - at.getTime() > 14 * 24 * 3600 * 1000,
  );
  const tables: Table[] = [
    {
      key: 'quiet',
      title: 'Associates with no contact in 14 days',
      columns: [
        { key: 'name', label: 'Associate', format: 'text' },
        { key: 'last', label: 'Last contact', format: 'text' },
      ],
      rows: quiet.map(([name, at]) => ({
        name,
        last: at.getTime() === 0 ? 'Never' : istDate(at),
      })),
      empty: 'Every associate was contacted in the last 14 days.',
    },
  ];
  if (ctx.monthly) {
    tables.push({
      key: 'associates',
      title: 'Per associate',
      columns: [
        { key: 'name', label: 'Associate', format: 'text' },
        ...KINDS.filter(([k]) => ['calls', 'agreed', 'office', 'site'].includes(k)).map(
          ([k, l]) => ({
            key: k,
            label: l,
          }),
        ),
      ],
      rows: [...per.entries()].map(([name, m]) => ({
        name,
        calls: (m.ASSOCIATE_CALL || 0) + (m.ASSOCIATE_NEW_CALL || 0),
        agreed: m.AGREED || 0,
        office: m.ASSOCIATE_OFFICE_VISIT || 0,
        site: m.ASSOCIATE_SITE_VISIT || 0,
      })),
      empty: 'Nothing logged this month.',
    });
  }
  return {
    headline: KINDS.map(([k, l, kinds, pick]) =>
      h(
        k,
        l,
        value(kinds, pick, ctx.range, now),
        value(kinds, pick, ctx.prev, before),
        'number',
        '/associates',
      ),
    ),
    tables,
    exceptions: quiet.length
      ? [
          {
            text: `${plural(quiet.length, 'associate')} not contacted in 14 days`,
            link: '/associates',
          },
        ]
      : [],
    next: 'Log every associate call on the Associates page. Office and site visits can be logged there too. Everything is counted from it.',
  };
}

async function hrReport(ctx: Ctx): Promise<Partial<ReportDoc>> {
  const { companyIds } = ctx.subject;
  const staff = await staffOf(companyIds, ctx.range.start);
  const ids = staff.map((s) => s.id);
  const [att, events, prevEvents, proposals, pending, leave, newJoiners, leavers] =
    await Promise.all([
      attendanceBy(ids, ctx.range),
      stampedEvents(ids, ctx.range, ['UNINFORMED_ABSENT', 'MISSING_DAILY_REPORT']),
      stampedEvents(ids, ctx.prev, ['UNINFORMED_ABSENT', 'MISSING_DAILY_REPORT']),
      p.attendanceProposal.groupBy({
        by: ['status'],
        where: {
          employee_id: { in: ids },
          reviewed_at: { gte: ctx.range.start, lt: ctx.range.end },
        },
        _count: { _all: true },
      }),
      p.attendanceProposal.findMany({
        where: { employee_id: { in: ids }, status: 'PENDING' },
        select: { created_at: true },
        orderBy: { created_at: 'asc' },
      }),
      leaveDays(ids, ctx.range),
      p.employee.count({
        where: {
          company_id: { in: companyIds },
          created_at: { gte: ctx.range.start, lt: ctx.range.end },
        },
      }),
      p.employee.count({
        where: {
          company_id: { in: companyIds },
          last_working_day: { gte: ctx.range.start, lt: ctx.range.end },
        },
      }),
    ]);
  const total = (rows: typeof events, action: string) =>
    rows.filter((e) => e.action === action).reduce((n, e) => n + e._count._all, 0);
  const decided = (st: string) => proposals.find((x) => x.status === st)?._count._all || 0;
  const tables: Table[] = [
    {
      key: 'people',
      title: 'By person',
      columns: [
        { key: 'name', label: 'Name', format: 'text' },
        { key: 'present', label: 'Days present' },
        { key: 'late', label: 'Late' },
        { key: 'half_day', label: 'Half day' },
        { key: 'leave', label: 'Leave days' },
        { key: 'absent', label: 'Absent (not informed)' },
        { key: 'reports_missed', label: 'Reports missed' },
      ],
      rows: staff.map((x) => ({
        _employee: x.id,
        name: nameOf(x),
        present: att.present(x.id),
        late: att.late(x.id),
        half_day: att.halfDay(x.id),
        leave: leave.get(x.id) || 0,
        absent: countFor(events, x.id, 'UNINFORMED_ABSENT'),
        reports_missed: countFor(events, x.id, 'MISSING_DAILY_REPORT'),
      })),
      hint: ctx.monthly ? 'This is the payroll input sheet: export it as CSV.' : undefined,
    },
  ];
  if (ctx.monthly) {
    const [inputs, adjustments] = await Promise.all([
      scoreInputs(ids, ctx.range, ctx.now),
      p.performanceAdjustment.count({
        where: {
          employee_id: { in: ids },
          created_at: { gte: ctx.range.start, lt: ctx.range.end },
        },
      }),
    ]);
    const zones = { Excellent: 0, Safe: 0, Satisfactory: 0, Danger: 0 };
    for (const i of inputs.values()) {
      const s = calculatePerformanceScore(i).score;
      zones[s >= 86 ? 'Excellent' : s >= 66 ? 'Safe' : s >= 41 ? 'Satisfactory' : 'Danger']++;
    }
    tables.push({
      key: 'scores',
      title: 'Performance scores',
      columns: [
        { key: 'zone', label: 'Zone', format: 'text' },
        { key: 'people', label: 'People' },
      ],
      rows: [
        ...Object.entries(zones).map(([zone, people]) => ({ zone, people })),
        { zone: 'Score adjustments given', people: adjustments },
      ],
    });
  }
  const oldest = pending[0]?.created_at || null;
  return {
    headline: [
      h('on_time', 'On-time check-ins', att.total(['PRESENT']), null, 'number', '/hr-attendance'),
      h('late', 'Late check-ins', att.total(['LATE']), null, 'number', '/hr-attendance'),
      h('half_day', 'Half days', att.total(['HALF_DAY']), null, 'number', '/hr-attendance'),
      h(
        'absent',
        'Uninformed absences',
        total(events, 'UNINFORMED_ABSENT'),
        total(prevEvents, 'UNINFORMED_ABSENT'),
        'number',
        '/hr-attendance',
      ),
      h(
        'reports_missed',
        'Daily reports missed',
        total(events, 'MISSING_DAILY_REPORT'),
        total(prevEvents, 'MISSING_DAILY_REPORT'),
        'number',
        '/hr-daily-reports',
      ),
      h('approved', 'Requests approved', decided('APPROVED'), null, 'number', '/approvals'),
      h('rejected', 'Requests rejected', decided('REJECTED'), null, 'number', '/approvals'),
      h(
        'leave',
        'Leave days taken',
        [...leave.values()].reduce((a, b) => a + b, 0),
        null,
      ),
      h('joiners', 'Joined', newJoiners, null),
      h('leavers', 'Left', leavers, null),
    ],
    tables,
    exceptions: pending.length
      ? [
          {
            text: `${plural(pending.length, 'request')} still waiting (oldest ${daysOld(oldest, ctx.now)} days)`,
            link: '/approvals',
          },
        ]
      : [],
    next: `${plural(pending.length, 'request')} to decide.`,
  };
}

async function financeReport(ctx: Ctx): Promise<Partial<ReportDoc>> {
  const { companyIds } = ctx.subject;
  const co = { company_id: { in: companyIds } };
  const r = { gte: ctx.range.start, lt: ctx.range.end };
  const nextP = nextPeriod(ctx.period);
  const [
    collected,
    prevCollected,
    verifiedN,
    refundedN,
    failed,
    pending,
    refundDue,
    dueNext,
    owed,
  ] = await Promise.all([
    collectedIn(companyIds, ctx.range),
    collectedIn(companyIds, ctx.prev),
    p.auditEvent.count({ where: { ...co, action: 'PAYMENT_VERIFIED', created_at: r } }),
    p.auditEvent.count({ where: { ...co, action: 'PAYMENT_REFUNDED', created_at: r } }),
    p.payment.count({ where: { ...co, status: 'FAILED', updated_at: r } }),
    p.payment.findMany({
      where: { ...co, status: 'PENDING' },
      select: { amount: true, created_at: true },
      orderBy: { created_at: 'asc' },
    }),
    p.payment.aggregate({
      where: { ...co, status: 'REFUND_DUE' },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    p.installment.findMany({
      where: {
        booking: co,
        status: { notIn: ['CANCELLED', 'RECEIVED'] },
        due_date: { gte: nextP.start, lt: nextP.end },
      },
      select: {
        expected_amount: true,
        received_amount: true,
        due_date: true,
        booking: { select: { booking_code: true } },
      },
      orderBy: { due_date: 'asc' },
      take: 50,
    }),
    outstanding(companyIds, ctx.now),
  ]);
  const tables: Table[] = [
    {
      key: 'due_next',
      title: `Installments due ${ctx.period.type === 'WEEK' ? 'next week' : 'next month'}`,
      columns: [
        { key: 'booking', label: 'Booking', format: 'text' },
        { key: 'due', label: 'Due on', format: 'text' },
        { key: 'amount', label: 'Amount', format: 'money' },
      ],
      rows: dueNext.map((i) => ({
        booking: i.booking.booking_code,
        due: istDate(i.due_date),
        amount: num(i.expected_amount) - num(i.received_amount),
      })),
      empty: 'Nothing due.',
    },
  ];
  if (ctx.monthly) {
    const ids = Prisma.join(companyIds.length ? companyIds : [0]);
    const ages = await p.$queryRaw<{ bucket: string; amount: number | null }[]>`
      SELECT CASE WHEN i.due_date >= ${ctx.now} THEN 'Not due yet'
                  WHEN i.due_date >= ${new Date(ctx.now.getTime() - 30 * 864e5)} THEN '1 to 30 days late'
                  WHEN i.due_date >= ${new Date(ctx.now.getTime() - 60 * 864e5)} THEN '31 to 60 days late'
                  ELSE 'More than 60 days late' END AS bucket,
             SUM(i.expected_amount - i.received_amount) AS amount
      FROM Installment i JOIN Booking b ON b.id = i.booking_id
      WHERE b.company_id IN (${ids}) AND b.status IN ('CONFIRMED','REGISTERED','COMPLETED')
        AND i.status NOT IN ('CANCELLED','RECEIVED')
      GROUP BY bucket`;
    const deals = await dealsIn(companyIds, ctx.range);
    const paid = deals.length
      ? await p.payment.groupBy({
          by: ['booking_id'],
          where: { booking_id: { in: deals.map((d) => d.id) }, status: 'SUCCESS' },
          _sum: { amount: true },
        })
      : [];
    tables.push(
      {
        key: 'ages',
        title: 'Outstanding by age',
        columns: [
          { key: 'bucket', label: 'Age', format: 'text' },
          { key: 'amount', label: 'Amount', format: 'money' },
        ],
        rows: ages.map((a) => ({ bucket: a.bucket, amount: Number(a.amount || 0) })),
        empty: 'Nothing outstanding.',
      },
      {
        key: 'confirmed_paid',
        title: 'Bookings confirmed this month and what they paid',
        columns: [
          { key: 'booking', label: 'Booking', format: 'text' },
          { key: 'project', label: 'Project', format: 'text' },
          { key: 'price', label: 'Agreed price', format: 'money' },
          { key: 'paid', label: 'Paid', format: 'money' },
        ],
        rows: deals.map((d) => ({
          booking: d.booking_code,
          project: d.project,
          price: d.agreed_price,
          paid: num(paid.find((x) => x.booking_id === d.id)?._sum.amount),
        })),
        empty: 'No bookings confirmed.',
        hint: 'The reconciliation list for the accountant.',
      },
    );
  }
  const oldest = pending[0]?.created_at || null;
  return {
    headline: [
      h('collected', 'Collected', collected.amount, prevCollected.amount, 'money', '/finance'),
      h('verified', 'Payments verified', verifiedN, null, 'number', '/finance'),
      h('failed', 'Payments rejected', failed, null, 'number', '/finance'),
      h('refunds', 'Refunds settled', refundedN, null, 'number', '/finance'),
      h('outstanding', 'Outstanding now', owed.amount, null, 'money', '/finance'),
      h('overdue', 'Overdue now', owed.overdue, null, 'money', '/finance'),
    ],
    tables,
    exceptions: [
      ...(pending.length
        ? [
            {
              text: `${plural(pending.length, 'payment')} waiting to be verified (oldest ${daysOld(oldest, ctx.now)} days)`,
              link: '/finance',
            },
          ]
        : []),
      ...(refundDue._count._all
        ? [
            {
              text: `${plural(refundDue._count._all, 'refund')} due (${money(num(refundDue._sum.amount))})`,
              link: '/finance',
            },
          ]
        : []),
    ],
    next: `${nextP.label}: ${plural(dueNext.length, 'installment')} due (${money(dueNext.reduce((n, i) => n + num(i.expected_amount) - num(i.received_amount), 0))}).`,
  };
}

async function technicalReport(ctx: Ctx): Promise<Partial<ReportDoc>> {
  const { companyIds } = ctx.subject;
  const co = { company_id: { in: companyIds } };
  const r = { gte: ctx.range.start, lt: ctx.range.end };
  const pr = { gte: ctx.prev.start, lt: ctx.prev.end };
  const ev = (where: Prisma.AuditEventWhereInput) => p.auditEvent.count({ where });
  const [jobs, locked, failedIn, signIns, prevSignIns, perms, resets, changes, noTwoStep] =
    await Promise.all([
      p.notification.count({ where: { type: 'JOB_FAILED', created_at: r } }),
      ev({ action: 'SECURITY_ALERT', entity_type: 'ACCOUNT_LOCKED', created_at: r }),
      ev({ action: 'SECURITY_ALERT', entity_type: 'AUTH_FAILED', created_at: r }),
      ev({ action: 'LOGIN', created_at: r, ...co }),
      ev({ action: 'LOGIN', created_at: pr, ...co }),
      ev({
        created_at: r,
        action: {
          in: [
            'UPDATE_ROLE_PERMISSIONS',
            'RESET_ROLE_PERMISSIONS',
            'UNDO_ROLE_PERMISSIONS',
            'REDO_ROLE_PERMISSIONS',
            'CLEAR_EMPLOYEE_PERMISSION_OVERRIDE',
          ],
        },
      }),
      ev({ action: CRM_ACTION, created_at: r, new_value: { contains: '/reset-password' }, ...co }),
      p.auditEvent.groupBy({
        by: ['actor_id'],
        where: { action: CRM_ACTION, created_at: r, ...co },
        _count: { _all: true },
      }),
      p.employee.findMany({
        where: {
          ...co,
          status: 'ACTIVE',
          totp_enabled_at: null,
          roles: {
            some: {
              role: {
                name: { in: [Roles.MD, Roles.ADMIN, Roles.FINANCE, Roles.TECHNICAL_MANAGER] },
              },
            },
          },
        },
        select: { full_name: true, employee_code: true },
      }),
    ]);
  const staff = await staffOf(companyIds);
  const byId = new Map(staff.map((s) => [s.id, s]));
  const tables: Table[] = [
    {
      key: 'changes',
      title: 'CRM changes per person',
      columns: [
        { key: 'name', label: 'Name', format: 'text' },
        { key: 'changes', label: 'Changes' },
      ],
      rows: changes
        .map((c) => ({
          _employee: c.actor_id,
          name: byId.get(c.actor_id) ? nameOf(byId.get(c.actor_id)!) : `#${c.actor_id}`,
          changes: c._count._all,
        }))
        .sort((a, b) => b.changes - a.changes),
      empty: 'No changes.',
    },
    {
      key: 'two_step',
      title: '2-step login not set up (optional)',
      columns: [{ key: 'name', label: 'Name', format: 'text' }],
      rows: noTwoStep.map((e) => ({ name: nameOf(e) })),
      empty: 'Everyone has set it up.',
    },
  ];
  if (ctx.monthly) {
    const [noOwner, dupes] = await Promise.all([
      p.lead.count({
        where: { ...co, assigned_to_id: null, status: { notIn: ['BOOKED', 'DROPPED'] } },
      }),
      p.lead.groupBy({
        by: ['phone'],
        where: co,
        _count: { _all: true },
        having: { phone: { _count: { gt: 1 } } },
      }),
    ]);
    tables.push(
      {
        key: 'access',
        title: 'Who holds which role',
        columns: [
          { key: 'name', label: 'Name', format: 'text' },
          { key: 'roles', label: 'Roles', format: 'text' },
        ],
        rows: staff.map((s) => ({ name: nameOf(s), roles: s.roles.join(', ') })),
      },
      {
        key: 'quality',
        title: 'Data quality',
        columns: [
          { key: 'issue', label: 'Issue', format: 'text' },
          { key: 'count', label: 'Count' },
        ],
        rows: [
          { issue: 'Open leads with no owner', count: noOwner },
          { issue: 'Phone numbers on more than one lead', count: dupes.length },
        ],
      },
    );
  }
  return {
    headline: [
      h('jobs', 'Background job failures', jobs, null),
      h('locked', 'Accounts locked', locked, null),
      h('failed', 'Failed sign-ins', failedIn, null),
      h('sign_ins', 'Sign-ins', signIns, prevSignIns),
      h('permissions', 'Permission changes', perms, null, 'number', '/access-control'),
      h('resets', 'Password resets', resets, null),
    ],
    tables,
    exceptions: [
      ...(jobs ? [{ text: `${plural(jobs, 'background job')} failed` }] : []),
      ...(locked ? [{ text: `${plural(locked, 'account')} locked after wrong passwords` }] : []),
    ],
    next: 'Next: check failed jobs and locked accounts first.',
  };
}

const BUILDERS: Record<ReportKind, (ctx: Ctx) => Promise<Partial<ReportDoc>>> = {
  COMPANY: companyReport,
  SALES: salesReport,
  PERSONAL: personalReport,
  PM: pmReport,
  CHANNEL: channelReport,
  HR: hrReport,
  FINANCE: financeReport,
  TECHNICAL: technicalReport,
};

export async function buildReport(
  subject: Subject,
  period: Period,
  now: Date = new Date(),
): Promise<ReportDoc> {
  const closed = isClosed(period, now);
  // An open period is compared with the previous one cut at the same point.
  const prev = previousComparable(period, now);
  const ctx: Ctx = {
    subject,
    period,
    range: {
      start: period.start,
      end: closed ? period.end : new Date(Math.min(period.end.getTime(), now.getTime() + 1)),
    },
    prev: { start: prev.start, end: prev.end },
    prevLabel: prev.label,
    now,
    monthly: period.type === 'MONTH',
  };
  const part = await BUILDERS[subject.kind](ctx);
  const who = subject.person ? nameOf(subject.person) : null;
  return {
    version: REPORT_VERSION,
    kind: subject.kind,
    title: `${REPORT_KINDS[subject.kind]}${who ? `: ${who}` : ''}`,
    subject: subject.person ? { id: subject.person.id, name: who! } : null,
    period: {
      type: period.type,
      start: period.start.toISOString(),
      end: period.end.toISOString(),
      startDate: period.startDate,
      label: period.label,
    },
    previous_label: closed ? prev.label : `${prev.label}, same point`,
    headline: part.headline || [],
    tables: part.tables || [],
    exceptions: part.exceptions || [],
    next: part.next || '',
    generated_at: now.toISOString(),
  };
}

/** The default report key for a person (their own role's), used by the job. */
export function defaultKind(user: TokenPayload): ReportKind {
  return kindsFor(user)[0];
}
