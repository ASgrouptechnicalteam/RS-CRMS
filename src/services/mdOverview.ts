import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { TokenPayload } from '../utils/jwt';
import { getAccessibleCompanyIds } from '../authz/dataScope';
import { buildApprovalsInbox } from '../routes/md';
import { AnalyticsService } from './analytics.service';
import { calculatePerformanceScore } from './performance-metric';
import {
  daysIn,
  periodContaining,
  previousComparable,
  istDate,
  istMidnight,
} from './counts/period';
import {
  callsByDay,
  collectedIn,
  dealTotals,
  dealsIn,
  funnel,
  leadSources,
  leadsAtRisk,
  negotiationNow,
  visitSplit,
  outstanding,
  personStats,
  scoreInputs,
  visitCounts,
} from './counts/metrics';
import { groupOf, nameOf, rankBy, staffOf } from './counts/people';
import { targetAttainment } from './reports/periodReports';

/**
 * GET /md/overview (owner point 5): the MD's dashboard in one request, for
 * today, this week or this month (IST). Every number comes from the shared
 * definitions in services/counts/metrics.ts, so it matches the reports, the
 * targets and Achievements. Grouped queries only, run a few at a time: the
 * database pool has 5 connections.
 */

const p = prisma;
const PERIODS = { today: 'DAY', week: 'WEEK', month: 'MONTH', all: 'ALL' } as const;
export type OverviewPeriod = keyof typeof PERIODS;

const change = (value: number, previous: number) => ({ value, previous });

export async function mdOverview(user: TokenPayload, key: string, now: Date = new Date()) {
  const periodKey: OverviewPeriod = key in PERIODS ? (key as OverviewPeriod) : 'today';
  const period = periodContaining(PERIODS[periodKey], now);
  const range = {
    start: period.start,
    end: new Date(Math.min(period.end.getTime(), now.getTime() + 1)),
  };
  // All time has nothing before it: compare against an empty range.
  const isAll = periodKey === 'all';
  const prevCut = isAll
    ? { start: period.start, end: period.start, label: '' }
    : previousComparable(period, now);
  const prev = { start: prevCut.start, end: prevCut.end };
  const companyIds = await getAccessibleCompanyIds(user);
  const co = { company_id: { in: companyIds } };

  // Sparklines: the last 7 IST days (this month's days for the month view,
  // the last 30 days for all time).
  const trendStart =
    periodKey === 'month'
      ? period.start
      : istMidnight(daysIn(new Date(now.getTime() - (isAll ? 29 : 6) * 864e5), now)[0]);
  const trendRange = { start: trendStart, end: new Date(now.getTime() + 1) };
  const days = daysIn(trendStart, trendRange.end);

  const [deals, prevDeals, collected, prevCollected] = await Promise.all([
    dealsIn(companyIds, range),
    dealsIn(companyIds, prev),
    collectedIn(companyIds, range),
    collectedIn(companyIds, prev),
  ]);
  const [f, prevF, owed] = await Promise.all([
    funnel(companyIds, range),
    funnel(companyIds, prev),
    outstanding(companyIds, now),
  ]);
  const [visits, prevVisits, risk, sources, callDays, nego, split] = await Promise.all([
    visitCounts(companyIds, range, now),
    visitCounts(companyIds, prev, now),
    leadsAtRisk(companyIds, now),
    leadSources(companyIds, range),
    callsByDay(companyIds, trendStart),
    negotiationNow(companyIds, now),
    // Whole period, so visits still to come later today / this week / this month count.
    visitSplit(companyIds, { start: range.start, end: period.end }, now),
  ]);

  // Daily series.
  const ids = Prisma.join(companyIds.length ? companyIds : [0]);
  const istDay = (col: string) => Prisma.raw(`DATE(DATE_ADD(${col}, INTERVAL 330 MINUTE))`);
  type DayRow = { d: Date | string; n: bigint | number | null };
  const [trendDeals, payDays, leadDays, visitDays, plannedDays] = await Promise.all([
    dealsIn(companyIds, trendRange),
    p.$queryRaw<DayRow[]>`SELECT ${istDay('payment_date')} d, SUM(amount) n FROM Payment
      WHERE company_id IN (${ids}) AND status = 'SUCCESS' AND payment_date >= ${trendStart} GROUP BY d`,
    p.$queryRaw<DayRow[]>`SELECT ${istDay('created_at')} d, COUNT(*) n FROM Lead
      WHERE company_id IN (${ids}) AND created_at >= ${trendStart} GROUP BY d`,
    p.$queryRaw<DayRow[]>`SELECT ${istDay('s.completed_at')} d, COUNT(*) n FROM SiteVisitBooking s
      JOIN Lead l ON l.id = s.lead_id
      WHERE l.company_id IN (${ids}) AND s.status = 'COMPLETED' AND s.visit_type = 'SCHEDULED'
        AND s.completed_at >= ${trendStart} GROUP BY d`,
    p.$queryRaw<DayRow[]>`SELECT ${istDay('s.scheduled_date')} d, COUNT(*) n FROM SiteVisitBooking s
      JOIN Lead l ON l.id = s.lead_id
      WHERE l.company_id IN (${ids}) AND s.status <> 'CANCELLED'
        AND s.scheduled_date >= ${trendStart} AND s.scheduled_date < ${trendRange.end} GROUP BY d`,
  ]);
  const dayKey = (d: Date | string) =>
    typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10);
  const series = (rows: DayRow[]) => {
    const m = new Map(rows.map((r) => [dayKey(r.d), Number(r.n || 0)]));
    return days.map((d) => m.get(d) || 0);
  };
  const dealsByDay = new Map<string, { n: number; v: number }>();
  for (const d of trendDeals) {
    const k = istDate(d.confirmed_at!);
    const cur = dealsByDay.get(k) || { n: 0, v: 0 };
    cur.n++;
    cur.v += d.agreed_price;
    dealsByDay.set(k, cur);
  }
  const callMap = new Map(callDays.map((c) => [c.d, c]));
  const trend = days.map((date, i) => ({
    date,
    deals: dealsByDay.get(date)?.n || 0,
    sales_value: dealsByDay.get(date)?.v || 0,
    collected: series(payDays)[i],
    leads: series(leadDays)[i],
    visits_done: series(visitDays)[i],
    calls: callMap.get(date)?.calls || 0,
    connected: callMap.get(date)?.connected || 0,
    visits_planned: series(plannedDays)[i],
  }));

  // Team: the sales ranking for the period, with this month's score.
  const staff = await staffOf(companyIds, range.start);
  const sales = staff.filter((s) => groupOf(s.roles) === 'SALES');
  const month = periodContaining('MONTH', now);
  const [stats, scores] = await Promise.all([
    personStats(
      companyIds,
      sales.map((s) => s.id),
      range,
      deals,
    ),
    scoreInputs(
      sales.map((s) => s.id),
      { start: month.start, end: month.end },
      now,
    ),
  ]);
  const targets = await targetAttainment(companyIds, period, now, sales, stats);
  const ranked = rankBy(
    sales.map((x) => ({ x, s: stats.get(x.id)! })),
    (r) => [r.s.deals, r.s.sales_value, r.s.visits_done, r.s.connected],
  ).map(({ x, s, rank }) => ({
    id: x.id,
    name: nameOf(x),
    role: x.roles.join(', '),
    rank,
    deals: s.deals,
    sales_value: s.sales_value,
    visits_done: s.visits_done,
    calls: s.calls,
    connected: s.connected,
    score: calculatePerformanceScore(scores.get(x.id)!).score,
    target: targets.byPerson.get(x.id) ?? null,
  }));
  const top = ranked.slice(0, 5);
  const bottom = ranked.slice(5).slice(-5).reverse();
  const roleTargets = new Map<string, number[]>();
  for (const r of ranked) {
    if (r.target === null) continue;
    for (const role of r.role.split(', '))
      roleTargets.set(role, [...(roleTargets.get(role) || []), r.target]);
  }

  // People today (whatever the period).
  const today = periodContaining('DAY', now);
  const inDay = { gte: today.start, lt: today.end };
  const working = { ...co, status: 'ACTIVE', roles: { none: { role: { is_invisible: true } } } };
  const [needAttendance, logs, needReport, reportsSent, exceptions] = await Promise.all([
    p.employee.count({ where: { ...working, attendance_required: true } }),
    p.attendanceLog.findMany({
      where: { employee: co, check_in_at: inDay },
      select: { employee_id: true, status: true },
    }),
    p.employee.count({ where: { ...working, report_required: true } }),
    p.dailyReport.count({ where: { employee: co, submitted_at: inDay } }),
    Promise.all(companyIds.map((c) => AnalyticsService.attendanceExceptionsToday(c))),
  ]);
  const checkedIn = new Set(logs.map((l) => l.employee_id)).size;
  const late = new Set(
    logs.filter((l) => ['LATE', 'HALF_DAY'].includes(l.status)).map((l) => l.employee_id),
  ).size;

  const ownerIds = [
    ...new Set([
      ...risk.by_owner.slice(0, 10).map((r) => r.owner_id),
      ...nego.by_owner.slice(0, 10).map((r) => r.owner_id),
    ]),
  ].filter((x): x is number => x !== null);
  const [inbox, propertyStatus, projectsInReview, owners] = await Promise.all([
    buildApprovalsInbox(user),
    p.property.groupBy({ by: ['status'], where: co, _count: { _all: true } }),
    p.project.count({
      where: { ...co, verification_status: { in: ['PENDING_DM_POLISH', 'PENDING_MD_APPROVAL'] } },
    }),
    p.employee.findMany({
      where: { id: { in: ownerIds } },
      select: { id: true, full_name: true, employee_code: true },
    }),
  ]);
  const ownerName = new Map(owners.map((o) => [o.id, nameOf(o)]));
  const prop = (st: string) => propertyStatus.find((x) => x.status === st)?._count._all || 0;
  const d = dealTotals(deals);
  const pd = dealTotals(prevDeals);
  const last = trend[trend.length - 1];

  return {
    generated_at: now.toISOString(),
    period: {
      key: periodKey,
      label:
        periodKey === 'today'
          ? 'Today'
          : periodKey === 'week'
            ? 'This week'
            : periodKey === 'month'
              ? 'This month'
              : 'All time',
      range_label: period.label,
      start: period.start,
      end: period.end,
      previous_label: isAll
        ? ''
        : periodKey === 'today'
          ? 'yesterday by this time'
          : `${prevCut.label}, same point`,
      // False for all time: there is no earlier period to compare with.
      compare: !isAll,
    },
    since_midnight: {
      leads: last?.leads || 0,
      deals: last?.deals || 0,
      collected: last?.collected || 0,
    },
    action: [...inbox.sections, inbox.overdue_tasks]
      .filter((s) => s.count > 0)
      .map((s) => ({
        key: s.key,
        label: s.label,
        link: s.link,
        count: s.count,
        oldest_at: s.oldest_at,
      }))
      .sort(
        (a, b) =>
          (a.oldest_at ? new Date(a.oldest_at).getTime() : Infinity) -
          (b.oldest_at ? new Date(b.oldest_at).getTime() : Infinity),
      ),
    money: {
      deals: change(d.count, pd.count),
      sales_value: change(d.value, pd.value),
      collected: change(collected.amount, prevCollected.amount),
      outstanding: owed,
    },
    lead_sources: sources,
    funnel: {
      stages: f.stages,
      new_leads: f.new_leads,
      booked: f.booked,
      rate: f.rate,
      previous_rate: prevF.rate,
      previous_new_leads: prevF.new_leads,
    },
    risk: {
      unassigned: risk.unassigned,
      stale_2: risk.stale_2,
      stale_5: risk.stale_5,
      by_owner: risk.by_owner
        .slice(0, 10)
        .map((r) => ({ ...r, name: ownerName.get(r.owner_id) || `#${r.owner_id}` })),
    },
    visits: {
      ...visits,
      previous_done: prevVisits.done,
      previous_planned: prevVisits.planned,
      split,
    },
    negotiation: {
      total: nego.total,
      stuck: nego.stuck,
      stuck_days: nego.stuck_days,
      by_owner: nego.by_owner.slice(0, 8).map((r) => ({
        ...r,
        name:
          r.owner_id === null ? 'Nobody assigned' : ownerName.get(r.owner_id) || `#${r.owner_id}`,
      })),
    },
    team: {
      top,
      bottom,
      size: ranked.length,
      calls_by_person: [...ranked]
        .filter((r) => r.calls > 0)
        .sort((a, b) => b.calls - a.calls || b.connected - a.connected)
        .slice(0, 8)
        .map((r) => ({ id: r.id, name: r.name, calls: r.calls, connected: r.connected })),
      targets: [...roleTargets.entries()].map(([role, list]) => ({
        role,
        people: list.length,
        percent: Math.round(list.reduce((a, b) => a + b, 0) / list.length),
      })),
    },
    people: {
      need_attendance: needAttendance,
      checked_in: checkedIn,
      late,
      absent: exceptions.reduce((n, e) => n + e.exceptions, 0),
      need_report: needReport,
      reports_sent: reportsSent,
    },
    inventory: {
      pending_verification: prop('PENDING_VERIFICATION'),
      pending_md: prop('PENDING_MD_APPROVAL'),
      live: prop('LIVE'),
      projects_in_review: projectsInReview,
    },
    trend,
  };
}
