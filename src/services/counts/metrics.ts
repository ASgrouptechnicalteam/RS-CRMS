import { num } from '../../utils/money';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { DEAL_STATUSES } from './deals';
import { aboutDaysIn } from './period';
import { CONNECTED } from '../lead/calls';
import { overdueInPeriod } from '../taskOverdue';
import { CALL_BACK_TITLE_PREFIX } from '../lead/callBacks';
import { calculateAttendancePoints } from '../../utils/time';
import { AttendanceStatusType } from '../../shared';
import { PerformanceScoreInputs } from '../performance-metric';

/**
 * The one set of business-number definitions (owner, 2026-11-08). Every
 * screen that shows one of these numbers reads it from here, so the MD
 * dashboard, the reports, targets and Achievements always agree.
 *
 *  - Deal (a booking): a booking at CONFIRMED, REGISTERED or COMPLETED, dated
 *    by the day it was confirmed (its BOOKING_CONFIRMED audit event; the first
 *    one if it was confirmed twice). Drafts, forms and bookings waiting for
 *    the MD are not deals.
 *  - Sales value: the agreed price of those deals.
 *  - Collected: customer payments marked SUCCESS, by payment date.
 *  - Outstanding: what is still expected on deals' installments (expected
 *    minus received, cancelled and fully received installments left out), as
 *    of now; "overdue" is the part past its due date.
 *  - Funnel: this period's new leads, by the furthest stage each reached
 *    (a dropped lead counts at the stage it was dropped from).
 *  - Conversion: this period's new leads that reached BOOKED, out of all of them.
 *  - Visit done: a scheduled visit completed in the period, credited to the
 *    agent who ran it, else the project manager (as targets count it).
 *  - Calls: logged call attempts; "connected" are the ones someone answered.
 *  - A leaver's leads: the leaver keeps the credit, at the stage the lead had
 *    reached when it was handed over; the new owner only counts leads they
 *    were given themselves.
 *
 * All queries are grouped (one per measure for everyone), never one per person:
 * the database pool has 5 connections.
 */

const p = prisma;

export interface Range {
  start: Date;
  /** Exclusive. */
  end: Date;
  /** Every date (Achievements "all time"). */
  all?: boolean;
}

const inRange = (r: Range) => ({ gte: r.start, lt: r.end });

// ---------------------------------------------------------------- deals

/** Booking ids first confirmed in the range (any company; filter the bookings). */
export async function bookingIdsConfirmedIn(range: Range): Promise<Map<number, Date>> {
  const events = await p.auditEvent.findMany({
    where: { action: 'BOOKING_CONFIRMED', created_at: inRange(range) },
    select: { entity_id: true, created_at: true },
  });
  const ids = [...new Set(events.map((e) => e.entity_id).filter((id) => !!id))];
  if (ids.length === 0) return new Map();
  const firsts = await p.auditEvent.groupBy({
    by: ['entity_id'],
    where: { action: 'BOOKING_CONFIRMED', entity_id: { in: ids } },
    _min: { created_at: true },
  });
  const out = new Map<number, Date>();
  for (const f of firsts) {
    const at = f._min.created_at;
    if (at && at >= range.start && at < range.end) out.set(f.entity_id, at);
  }
  return out;
}

export interface Deal {
  id: number;
  booking_code: string;
  agreed_price: number;
  assigned_employee_id: number | null;
  confirmed_at: Date | null;
  source: string | null;
  project: string;
  origin_lead_id: number | null;
}

/** Deals of these companies confirmed in the range (optionally only those credited to `employeeIds`). */
export async function dealsIn(
  companyIds: number[],
  range: Range,
  employeeIds?: number[],
): Promise<Deal[]> {
  const confirmed = range.all ? null : await bookingIdsConfirmedIn(range);
  if (confirmed && confirmed.size === 0) return [];
  const rows = await p.booking.findMany({
    where: {
      company_id: { in: companyIds },
      status: { in: DEAL_STATUSES },
      ...(confirmed ? { id: { in: [...confirmed.keys()] } } : {}),
      ...(employeeIds ? { assigned_employee_id: { in: employeeIds } } : {}),
    },
    select: {
      id: true,
      booking_code: true,
      agreed_price: true,
      assigned_employee_id: true,
      source: true,
      customer: { select: { origin_lead_id: true } },
      project_unit: { select: { project: { select: { name: true } } } },
      property: { select: { project: { select: { name: true } } } },
    },
  });
  return rows.map((b) => ({
    id: b.id,
    booking_code: b.booking_code,
    agreed_price: num(b.agreed_price),
    assigned_employee_id: b.assigned_employee_id,
    confirmed_at: confirmed?.get(b.id) || null,
    source: b.source,
    project: b.project_unit?.project?.name || b.property?.project?.name || 'Other properties',
    origin_lead_id: b.customer?.origin_lead_id ?? null,
  }));
}

export const dealTotals = (deals: Deal[]) => ({
  count: deals.length,
  value: deals.reduce((n, d) => n + d.agreed_price, 0),
});

/** Every deal ever, for lifetime cards. */
export async function lifetimeDeals(companyIds: number[]) {
  const r = await p.booking.aggregate({
    where: { company_id: { in: companyIds }, status: { in: DEAL_STATUSES } },
    _count: { _all: true },
    _sum: { agreed_price: true },
  });
  return { count: r._count._all, value: num(r._sum.agreed_price) };
}

// ---------------------------------------------------------------- money

export async function collectedIn(companyIds: number[], range: Range) {
  const r = await p.payment.aggregate({
    where: { company_id: { in: companyIds }, status: 'SUCCESS', payment_date: inRange(range) },
    _sum: { amount: true },
    _count: { _all: true },
  });
  return { amount: num(r._sum.amount), count: r._count._all };
}

export async function outstanding(companyIds: number[], now: Date = new Date()) {
  const ids = Prisma.join(companyIds.length ? companyIds : [0]);
  const statuses = Prisma.join(DEAL_STATUSES);
  const rows = await p.$queryRaw<{ due: number | null; overdue: number | null }[]>`
    SELECT COALESCE(SUM(i.expected_amount - i.received_amount), 0) AS due,
           COALESCE(SUM(CASE WHEN i.due_date < ${now} THEN i.expected_amount - i.received_amount ELSE 0 END), 0) AS overdue
    FROM Installment i JOIN Booking b ON b.id = i.booking_id
    WHERE b.company_id IN (${ids}) AND b.status IN (${statuses})
      AND i.status NOT IN ('CANCELLED', 'RECEIVED')`;
  return { amount: Number(rows[0]?.due || 0), overdue: Number(rows[0]?.overdue || 0) };
}

// ---------------------------------------------------------------- funnel

export const FUNNEL_STAGES = [
  { key: 'NEW', label: 'New' },
  { key: 'CONTACTED', label: 'Contacted' },
  { key: 'QUALIFIED', label: 'Qualified' },
  { key: 'VISIT_DONE', label: 'Site visit done' },
  { key: 'BOOKING', label: 'Booking started' },
  { key: 'BOOKED', label: 'Booked' },
] as const;

const STAGE_RANK: Record<string, number> = {
  CONTACTED: 1,
  QUALIFIED: 2,
  DEMO_SCHEDULED: 2,
  DEMO_COMPLETED: 2,
  SITE_VISIT_SCHEDULED: 2,
  SITE_VISIT_COMPLETED: 3,
  NEGOTIATION: 3,
  BOOKING_INITIATED: 4,
  BOOKED: 5,
};
/** How far a lead got (0 = new) from its status, or the stage it was dropped from. */
export const stageRank = (status: string | null, exitedFrom?: string | null) =>
  status === 'DROPPED' ? STAGE_RANK[exitedFrom || ''] || 0 : STAGE_RANK[status || ''] || 0;

/** Leads credited to these people: their own, plus leads they left behind (at the handed-over stage). */
const creditedTo = (ids: number[]): Prisma.LeadWhereInput => ({
  OR: [
    { assigned_to_id: { in: ids }, handed_over_from_id: null },
    { handed_over_from_id: { in: ids } },
  ],
});

export async function funnel(companyIds: number[], range: Range, employeeIds?: number[]) {
  const groups = await p.lead.groupBy({
    by: ['status', 'exited_from_status', 'handover_status', 'handed_over_from_id'],
    where: {
      company_id: { in: companyIds },
      ...(range.all ? {} : { created_at: inRange(range) }),
      ...(employeeIds ? creditedTo(employeeIds) : {}),
    },
    _count: { _all: true },
  });
  const reached = FUNNEL_STAGES.map(() => 0);
  for (const g of groups) {
    const leaverRow =
      employeeIds && g.handed_over_from_id && employeeIds.includes(g.handed_over_from_id);
    const rank = leaverRow
      ? stageRank(g.handover_status)
      : stageRank(g.status, g.exited_from_status);
    for (let i = 0; i <= rank; i++) reached[i] += g._count._all;
  }
  const stages = FUNNEL_STAGES.map((s, i) => ({
    key: s.key,
    label: s.label,
    count: reached[i],
    // Share of the stage before that got this far.
    conversion: i === 0 ? null : pct(reached[i], reached[i - 1]),
  }));
  return { stages, ...conversionOf(reached[0], reached[5]) };
}

export const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);
export const conversionOf = (newLeads: number, booked: number) => ({
  new_leads: newLeads,
  booked,
  rate: pct(booked, newLeads),
});

/** Conversion of this range's new leads (company-wide). */
export async function conversion(companyIds: number[], range: Range) {
  const f = await funnel(companyIds, range);
  return { new_leads: f.new_leads, booked: f.booked, rate: f.rate };
}

// ---------------------------------------------------------------- visits

/** Visits a person ran: the agent, else the project manager. */
export const visitDoneBy = (employeeId: number): Prisma.SiteVisitBookingWhereInput => ({
  OR: [
    { assigned_agent_id: employeeId },
    { assigned_agent_id: null, project_manager_id: employeeId },
  ],
});
export const visitDoneWhere = (range: Range): Prisma.SiteVisitBookingWhereInput => ({
  visit_type: 'SCHEDULED',
  status: 'COMPLETED',
  completed_at: inRange(range),
});
export const visitBookedWhere = (range: Range): Prisma.SiteVisitBookingWhereInput => ({
  visit_type: { in: ['SCHEDULED', 'DIRECT'] },
  status: { not: 'CANCELLED' },
  created_at: inRange(range),
});
export const WAITING_PM = ['REQUESTED', 'PENDING_ACCEPTANCE', 'REASSIGNED'] as const;

export async function visitCounts(companyIds: number[], range: Range, now: Date = new Date()) {
  const lead = { company_id: { in: companyIds } };
  const pastEnd = new Date(Math.min(range.end.getTime(), now.getTime()));
  const [planned, booked, done, walkIns, notDone, waitingPm, escalated] = await Promise.all([
    p.siteVisitBooking.count({
      where: { lead, scheduled_date: inRange(range), status: { not: 'CANCELLED' } },
    }),
    p.siteVisitBooking.count({ where: { lead, ...visitBookedWhere(range) } }),
    p.siteVisitBooking.count({ where: { lead, ...visitDoneWhere(range) } }),
    p.siteVisitBooking.count({
      where: {
        lead,
        status: 'COMPLETED',
        visit_type: { not: 'SCHEDULED' },
        completed_at: inRange(range),
      },
    }),
    // Time passed, never marked done or cancelled: a no-show or not updated.
    p.siteVisitBooking.count({
      where: {
        lead,
        scheduled_date: { gte: range.start, lt: pastEnd },
        status: { notIn: ['COMPLETED', 'CANCELLED'] },
      },
    }),
    p.siteVisitBooking.count({ where: { lead, status: { in: [...WAITING_PM] } } }),
    p.siteVisitBooking.count({ where: { lead, status: 'ESCALATED_TO_MARKETING_DIRECTOR' } }),
  ]);
  return {
    planned,
    booked,
    done,
    walk_ins: walkIns,
    not_done: notDone,
    waiting_pm: waitingPm,
    escalated,
  };
}

// ---------------------------------------------------------------- leads at risk

/** Statuses the lead follow-up and stale-lead jobs leave alone (jobs/tasks.ts). */
const NOT_CHASED = ['DROPPED', 'BOOKED', 'NEGOTIATION', 'BOOKING_INITIATED', 'RECOVERED_TO_POOL'];

/**
 * Open leads with no activity for 2+ and 5+ days, by owner (the same rule as
 * the 08:00 follow-up and the stale-lead jobs), plus open leads with no owner.
 * One grouped query.
 */
export async function leadsAtRisk(
  companyIds: number[],
  now: Date = new Date(),
  ownerIds?: number[],
) {
  const ids = Prisma.join(companyIds.length ? companyIds : [0]);
  const closed = Prisma.join(NOT_CHASED);
  const d2 = new Date(now.getTime() - 2 * 24 * 3600 * 1000);
  const d5 = new Date(now.getTime() - 5 * 24 * 3600 * 1000);
  const owners = ownerIds
    ? Prisma.sql`AND l.assigned_to_id IN (${Prisma.join(ownerIds.length ? ownerIds : [0])})`
    : Prisma.empty;
  const [rows, unassigned] = await Promise.all([
    p.$queryRaw<{ owner: number; s2: number | bigint; s5: number | bigint }[]>`
      SELECT x.owner, SUM(x.last_at < ${d2}) AS s2, SUM(x.last_at < ${d5}) AS s5
      FROM (
        SELECT l.assigned_to_id AS owner, COALESCE(MAX(a.created_at), l.created_at) AS last_at
        FROM Lead l LEFT JOIN LeadActivity a ON a.lead_id = l.id
        WHERE l.company_id IN (${ids}) AND l.assigned_to_id IS NOT NULL
          AND l.status NOT IN (${closed}) ${owners}
        GROUP BY l.id, l.assigned_to_id, l.created_at
      ) x
      GROUP BY x.owner`,
    p.lead.count({
      where: {
        company_id: { in: companyIds },
        assigned_to_id: null,
        status: { notIn: ['BOOKED', 'DROPPED'] },
      },
    }),
  ]);
  const byOwner = rows
    .map((r) => ({ owner_id: Number(r.owner), stale_2: Number(r.s2), stale_5: Number(r.s5) }))
    .filter((r) => r.stale_2 > 0)
    .sort((a, b) => b.stale_5 - a.stale_5 || b.stale_2 - a.stale_2);
  return {
    unassigned,
    stale_2: byOwner.reduce((n, r) => n + r.stale_2, 0),
    stale_5: byOwner.reduce((n, r) => n + r.stale_5, 0),
    by_owner: byOwner,
  };
}

// ---------------------------------------------------------------- calls

/** A logged call attempt in the range (the one definition: personStats and the MD charts). */
export const callsWhere = (range: Range): Prisma.LeadActivityWhereInput => ({
  activity_type: 'CALL_LOGGED',
  created_at: inRange(range),
});

/**
 * Calls and answered calls per IST day for these companies' leads (the same
 * count as Team Today). One grouped query.
 */
export async function callsByDay(companyIds: number[], since: Date) {
  const ids = Prisma.join(companyIds.length ? companyIds : [0]);
  const connected = Prisma.join(CONNECTED as string[]);
  const rows = await p.$queryRaw<
    { d: Date | string; n: bigint | number; c: bigint | number | null }[]
  >`
    SELECT DATE(DATE_ADD(la.created_at, INTERVAL 330 MINUTE)) d, COUNT(*) n,
      SUM(la.call_outcome IN (${connected})) c
    FROM LeadActivity la JOIN Lead l ON l.id = la.lead_id
    WHERE la.activity_type = 'CALL_LOGGED' AND l.company_id IN (${ids})
      AND la.created_at >= ${since} GROUP BY d`;
  return rows.map((r) => ({
    d: typeof r.d === 'string' ? r.d.slice(0, 10) : r.d.toISOString().slice(0, 10),
    calls: Number(r.n || 0),
    connected: Number(r.c || 0),
  }));
}

/** Friendly names for Lead.source codes. */
export const SOURCE_LABELS: Record<string, string> = {
  BULK_UPLOAD: 'Master data',
  WEBSITE: 'Website',
  FACEBOOK_ADS: 'Facebook',
  FACEBOOK: 'Facebook',
  GOOGLE_ADS: 'Google',
  MANUAL_ENTRY: 'Manual',
  WALK_IN: 'Walk-in',
  REFERRAL: 'Referral',
  HOUSING_COM: 'Housing.com',
  OTHER: 'Other',
};
const sourceLabel = (k: string) =>
  SOURCE_LABELS[k] ||
  k
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());

/** New leads in the range by source: the top 6, everything else as "Other". One grouped query. */
export async function leadSources(companyIds: number[], range: Range) {
  const rows = await p.lead.groupBy({
    by: ['source'],
    where: { company_id: { in: companyIds }, created_at: inRange(range) },
    _count: { _all: true },
  });
  const all = rows
    .map((r) => ({ key: r.source, label: sourceLabel(r.source), count: r._count._all }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const named = all.filter((r) => r.key !== 'OTHER');
  const top = named.slice(0, 6);
  const other =
    named.slice(6).reduce((n, r) => n + r.count, 0) +
    (all.find((r) => r.key === 'OTHER')?.count || 0);
  return other > 0 ? [...top, { key: 'OTHER', label: 'Other', count: other }] : top;
}

// ---------------------------------------------------------------- negotiation

/**
 * Leads in negotiation right now (a live count, not tied to a period), how many
 * have had no activity for `stuckDays`+, and who holds them. One grouped query.
 */
export async function negotiationNow(companyIds: number[], now: Date = new Date(), stuckDays = 7) {
  const ids = Prisma.join(companyIds.length ? companyIds : [0]);
  const cut = new Date(now.getTime() - stuckDays * 24 * 3600 * 1000);
  const rows = await p.$queryRaw<
    { owner: number | null; n: number | bigint; stuck: number | bigint }[]
  >`
    SELECT x.owner, COUNT(*) AS n, SUM(x.last_at < ${cut}) AS stuck
    FROM (
      SELECT l.assigned_to_id AS owner, COALESCE(MAX(a.created_at), l.created_at) AS last_at
      FROM Lead l LEFT JOIN LeadActivity a ON a.lead_id = l.id
      WHERE l.company_id IN (${ids}) AND l.status = 'NEGOTIATION'
      GROUP BY l.id, l.assigned_to_id, l.created_at
    ) x
    GROUP BY x.owner`;
  const by_owner = rows
    .map((r) => ({
      owner_id: r.owner === null ? null : Number(r.owner),
      count: Number(r.n),
      stuck: Number(r.stuck),
    }))
    .sort((a, b) => b.stuck - a.stuck || b.count - a.count);
  return {
    total: by_owner.reduce((n, r) => n + r.count, 0),
    stuck: by_owner.reduce((n, r) => n + r.stuck, 0),
    stuck_days: stuckDays,
    by_owner,
  };
}

/** Visits scheduled inside the range, split into done, still to come and time-passed-not-done. */
export async function visitSplit(companyIds: number[], range: Range, now: Date = new Date()) {
  const base = {
    lead: { company_id: { in: companyIds } },
    scheduled_date: inRange(range),
    status: { not: 'CANCELLED' as const },
  };
  const [done, upcoming, missed] = await Promise.all([
    p.siteVisitBooking.count({ where: { ...base, status: 'COMPLETED' } }),
    p.siteVisitBooking.count({
      where: {
        ...base,
        status: { notIn: ['COMPLETED', 'CANCELLED'] },
        scheduled_date: {
          gte: new Date(Math.max(range.start.getTime(), now.getTime())),
          lt: range.end,
        },
      },
    }),
    p.siteVisitBooking.count({
      where: {
        ...base,
        status: { notIn: ['COMPLETED', 'CANCELLED'] },
        scheduled_date: {
          gte: range.start,
          lt: new Date(Math.min(range.end.getTime(), now.getTime())),
        },
      },
    }),
  ]);
  return { done, upcoming, missed };
}

// ---------------------------------------------------------------- per person

export interface PersonStats {
  calls: number;
  connected: number;
  qualified: number;
  visits_booked: number;
  visits_done: number;
  deals: number;
  sales_value: number;
  /** Leads they added by hand (bulk uploads are not sourcing). */
  leads_added: number;
  /** ...of which reached Contacted or later. */
  leads_added_worked: number;
}

const emptyStats = (): PersonStats => ({
  calls: 0,
  connected: 0,
  qualified: 0,
  visits_booked: 0,
  visits_done: 0,
  deals: 0,
  sales_value: 0,
  leads_added: 0,
  leads_added_worked: 0,
});

/** The sales numbers for many people at once (about 8 grouped queries in total). */
export async function personStats(
  companyIds: number[],
  ids: number[],
  range: Range,
  deals?: Deal[],
): Promise<Map<number, PersonStats>> {
  const out = new Map<number, PersonStats>(ids.map((id) => [id, emptyStats()]));
  if (ids.length === 0) return out;
  const when = range.all ? {} : { created_at: inRange(range) };
  const lead = { company_id: { in: companyIds } };
  const [calls, qualified, booked, byAgent, byPm, added, dealRows] = await Promise.all([
    p.leadActivity.groupBy({
      by: ['actor_id', 'call_outcome'],
      where: {
        actor_id: { in: ids },
        ...(range.all ? { activity_type: 'CALL_LOGGED' } : callsWhere(range)),
      },
      _count: { _all: true },
    }),
    p.leadActivity.groupBy({
      by: ['actor_id'],
      where: {
        actor_id: { in: ids },
        activity_type: 'STATUS_CHANGED',
        notes: { contains: ' to QUALIFIED' },
        ...when,
      },
      _count: { _all: true },
    }),
    p.siteVisitBooking.groupBy({
      by: ['telecaller_id'],
      where: {
        lead,
        telecaller_id: { in: ids },
        ...(range.all
          ? { visit_type: { in: ['SCHEDULED', 'DIRECT'] }, status: { not: 'CANCELLED' } }
          : visitBookedWhere(range)),
      },
      _count: { _all: true },
    }),
    p.siteVisitBooking.groupBy({
      by: ['assigned_agent_id'],
      where: {
        lead,
        assigned_agent_id: { in: ids },
        visit_type: 'SCHEDULED',
        status: 'COMPLETED',
        ...(range.all ? {} : { completed_at: inRange(range) }),
      },
      _count: { _all: true },
    }),
    p.siteVisitBooking.groupBy({
      by: ['project_manager_id'],
      where: {
        lead,
        assigned_agent_id: null,
        project_manager_id: { in: ids },
        visit_type: 'SCHEDULED',
        status: 'COMPLETED',
        ...(range.all ? {} : { completed_at: inRange(range) }),
      },
      _count: { _all: true },
    }),
    p.lead.groupBy({
      by: ['created_by_id', 'status', 'exited_from_status'],
      where: { ...lead, created_by_id: { in: ids }, source: { not: 'BULK_UPLOAD' }, ...when },
      _count: { _all: true },
    }),
    deals ? Promise.resolve(deals) : dealsIn(companyIds, range, ids),
  ]);
  const get = (id: number | null) => (id ? out.get(id) : undefined);
  for (const c of calls) {
    const s = get(c.actor_id);
    if (!s) continue;
    s.calls += c._count._all;
    if (c.call_outcome && (CONNECTED as string[]).includes(c.call_outcome))
      s.connected += c._count._all;
  }
  for (const q of qualified) {
    const s = get(q.actor_id);
    if (s) s.qualified += q._count._all;
  }
  for (const v of booked) {
    const s = get(v.telecaller_id);
    if (s) s.visits_booked += v._count._all;
  }
  for (const v of byAgent) {
    const s = get(v.assigned_agent_id);
    if (s) s.visits_done += v._count._all;
  }
  for (const v of byPm) {
    const s = get(v.project_manager_id);
    if (s) s.visits_done += v._count._all;
  }
  for (const l of added) {
    const s = get(l.created_by_id);
    if (!s) continue;
    s.leads_added += l._count._all;
    if (stageRank(l.status, l.exited_from_status) >= 1) s.leads_added_worked += l._count._all;
  }
  for (const d of dealRows) {
    const s = get(d.assigned_employee_id);
    if (!s) continue;
    s.deals += 1;
    s.sales_value += d.agreed_price;
  }
  return out;
}

/**
 * Who assisted each deal: at most ONE person per booking, so one booking does
 * not credit everyone who ever touched the lead. The rule: the telecaller who
 * booked the lead's last completed site visit; if there is none, the lead's
 * owner (the leaver who handed it over keeps it). Never the closer.
 */
export async function assistsFor(deals: Deal[]): Promise<Map<number, number>> {
  const leadIds = [...new Set(deals.map((d) => d.origin_lead_id).filter((x): x is number => !!x))];
  const out = new Map<number, number>();
  if (leadIds.length === 0) return out;
  const [leads, visits] = await Promise.all([
    p.lead.findMany({
      where: { id: { in: leadIds } },
      select: { id: true, assigned_to_id: true, handed_over_from_id: true },
    }),
    p.siteVisitBooking.findMany({
      where: { lead_id: { in: leadIds }, status: 'COMPLETED' },
      select: { lead_id: true, telecaller_id: true, completed_at: true },
      orderBy: { completed_at: 'asc' },
    }),
  ]);
  const lastVisitBy = new Map<number, number>();
  for (const v of visits) lastVisitBy.set(v.lead_id, v.telecaller_id);
  const leadById = new Map(leads.map((l) => [l.id, l]));
  for (const d of deals) {
    if (!d.origin_lead_id) continue;
    const l = leadById.get(d.origin_lead_id);
    const helper =
      lastVisitBy.get(d.origin_lead_id) ?? l?.handed_over_from_id ?? l?.assigned_to_id ?? null;
    if (helper && helper !== d.assigned_employee_id) out.set(helper, (out.get(helper) || 0) + 1);
  }
  return out;
}

// ---------------------------------------------------------------- performance score inputs

/**
 * The performance-score inputs for many people in one month, grouped (about 8
 * queries in all, instead of 11 per person). Night-job events count in the
 * month of the day they are about, not the day the (often late) job ran.
 */
export async function scoreInputs(
  ids: number[],
  range: Range,
  now: Date = new Date(),
): Promise<Map<number, PerformanceScoreInputs>> {
  const out = new Map<number, PerformanceScoreInputs>();
  if (ids.length === 0) return out;
  const last = new Date(range.end.getTime() - 1); // inclusive end for lte filters
  const span = { gte: range.start, lte: last };
  const [tasks, overdue, reports, events, stamped, adjustments, logs] = await Promise.all([
    p.task.findMany({
      where: {
        assignee_id: { in: ids },
        status: 'COMPLETED',
        updated_at: span,
        NOT: { title: { startsWith: CALL_BACK_TITLE_PREFIX } },
      },
      select: { assignee_id: true, created_by: true },
    }),
    p.task.groupBy({
      by: ['assignee_id'],
      where: { assignee_id: { in: ids }, ...overdueInPeriod(range.start, last, now) },
      _count: { _all: true },
    }),
    p.dailyReport.groupBy({
      by: ['employee_id'],
      where: { employee_id: { in: ids }, submitted_at: span },
      _count: { _all: true },
    }),
    p.auditEvent.groupBy({
      by: ['actor_id', 'action'],
      where: {
        actor_id: { in: ids },
        action: {
          in: [
            'DAILY_REPORT_BELOW_TARGET',
            'DAILY_REPORT_TARGET_EXCEEDED',
            'PROPERTY_BOOKED_CONTRIBUTION',
          ],
        },
        created_at: span,
      },
      _count: { _all: true },
    }),
    p.auditEvent.groupBy({
      by: ['actor_id', 'action'],
      where: {
        actor_id: { in: ids },
        action: {
          in: [
            'UNINFORMED_ABSENT',
            'ATTENDANCE_AUTO_CHECKOUT_MIDNIGHT',
            'MISSING_DAILY_REPORT',
            'COMPLETED_ALL_WORK',
          ],
        },
        ...aboutDaysIn(range.start, range.end),
      },
      _count: { _all: true },
    }),
    p.performanceAdjustment.groupBy({
      by: ['employee_id'],
      where: { employee_id: { in: ids }, created_at: span },
      _sum: { points: true },
      _count: { _all: true },
    }),
    p.attendanceLog.findMany({
      where: { employee_id: { in: ids }, check_in_at: span },
      select: {
        employee_id: true,
        status: true,
        check_in_at: true,
        employee: { select: { employment_type: true } },
      },
    }),
  ]);
  for (const id of ids)
    out.set(id, {
      completedTasks: 0,
      overdueTasks: 0,
      dailyReports: 0,
      belowTargetEvents: 0,
      targetExceededEvents: 0,
      uninformedAbsentEvents: 0,
      midnightAutoCheckoutEvents: 0,
      missingDailyReportEvents: 0,
      completedAllWorkEvents: 0,
      propertyBookingContributions: 0,
      presentCount: 0,
      attendanceBoost: 0,
      lateCount: 0,
      halfDayCount: 0,
      manualAdjustmentsTotal: 0,
      manualAdjustmentsCount: 0,
    });
  // Self-assigned tasks never earn points.
  for (const t of tasks)
    if (t.created_by !== t.assignee_id) out.get(t.assignee_id)!.completedTasks++;
  for (const o of overdue) out.get(o.assignee_id)!.overdueTasks = o._count._all;
  for (const r of reports) out.get(r.employee_id)!.dailyReports = r._count._all;
  const field: Record<string, keyof PerformanceScoreInputs> = {
    DAILY_REPORT_BELOW_TARGET: 'belowTargetEvents',
    DAILY_REPORT_TARGET_EXCEEDED: 'targetExceededEvents',
    PROPERTY_BOOKED_CONTRIBUTION: 'propertyBookingContributions',
    UNINFORMED_ABSENT: 'uninformedAbsentEvents',
    ATTENDANCE_AUTO_CHECKOUT_MIDNIGHT: 'midnightAutoCheckoutEvents',
    MISSING_DAILY_REPORT: 'missingDailyReportEvents',
    COMPLETED_ALL_WORK: 'completedAllWorkEvents',
  };
  for (const e of [...events, ...stamped]) {
    const row = out.get(e.actor_id);
    if (row) (row[field[e.action]] as number) += e._count._all;
  }
  for (const a of adjustments) {
    const row = out.get(a.employee_id)!;
    row.manualAdjustmentsTotal = a._sum.points || 0;
    row.manualAdjustmentsCount = a._count._all;
  }
  for (const log of logs) {
    const row = out.get(log.employee_id)!;
    if (log.status === 'PRESENT' || log.status === 'APPROVED_LATE') row.presentCount++;
    if (log.status === 'LATE') row.lateCount++;
    if (log.status === 'HALF_DAY') row.halfDayCount++;
    if (log.status === 'PRESENT')
      row.attendanceBoost += calculateAttendancePoints(
        log.status as AttendanceStatusType,
        log.check_in_at,
        log.employee.employment_type || 'FULL_TIME',
      );
  }
  return out;
}
