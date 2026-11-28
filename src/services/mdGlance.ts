import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { TokenPayload } from '../utils/jwt';
import { getAccessibleCompanyIds } from '../authz/dataScope';
import { Roles } from '../shared';
import {
  daysIn,
  daysPeriod,
  istDate,
  istMidnight,
  periodContaining,
  previousComparable,
} from './counts/period';
import { dealsIn, dealTotals, visitBookedWhere, visitDoneWhere } from './counts/metrics';
import { DEAL_STATUSES } from './counts/deals';
import { nameOf } from './counts/people';

/**
 * The MD's dashboard (owner, 2026-11-28): bookings, negotiations, site visits completed and site visits
 * scheduled, each with quick links, plus who booked the visits. Every number is the length of a list of
 * record ids from mdRows(), and the page a number opens asks for that same list, so what it shows is
 * exactly what was counted.
 */

const p = prisma;
const DAY_MS = 24 * 3600 * 1000;
const QUIET_DAYS = 7;
const KEYS = { today: 'DAY', week: 'WEEK', month: 'MONTH', all: 'ALL' } as const;
const WORDS = { today: 'Today', week: 'This week', month: 'This month', all: 'All time' } as const;
type Key = keyof typeof KEYS;

export interface MdQuery {
  period?: unknown;
  from?: unknown;
  to?: unknown;
  md?: unknown;
  person?: unknown;
}

const isDay = (v: unknown): v is string =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(+new Date(v));

function pickPeriod(q: MdQuery, now: Date) {
  // "custom": the dates picked on the screen, both included.
  const custom =
    q.period === 'custom' && isDay(q.from) && isDay(q.to) && q.from <= q.to
      ? daysPeriod(q.from, q.to)
      : null;
  const key: Key = typeof q.period === 'string' && q.period in KEYS ? (q.period as Key) : 'today';
  const period = custom || periodContaining(KEYS[key], now);
  const isAll = !custom && key === 'all';
  const upTo = new Date(Math.min(period.end.getTime(), now.getTime() + 1));
  return {
    key: custom ? ('custom' as const) : key,
    label: custom ? period.label : WORDS[key],
    rangeLabel: period.label,
    period,
    isAll,
    /** Things that have happened (bookings, completed visits, visit bookings): up to now. */
    happened: { start: period.start, end: upTo },
    /** Visits dated in the period: the whole of it, those still to come too. */
    dated: { start: period.start, end: isAll ? new Date('2100-01-01') : period.end },
  };
}
type Picked = ReturnType<typeof pickPeriod>;

/** The period just before, cut at the same point, for "Before: N". None for all time. */
function before(x: Picked, now: Date) {
  if (x.isAll) return null;
  if (x.key !== 'custom') {
    const prev = previousComparable(x.period, now);
    return { start: prev.start, end: prev.end };
  }
  const length = x.period.end.getTime() - x.period.start.getTime();
  const elapsed = Math.max(0, Math.min(length, now.getTime() - x.period.start.getTime()));
  const start = new Date(x.period.start.getTime() - length);
  return { start, end: new Date(start.getTime() + elapsed) };
}

type Kind = 'booking' | 'lead' | 'visit';
interface Section {
  key: string;
  title: string;
  kind: Kind;
  /** Heading of the people list. */
  by: string;
  /** What a missing person is called. */
  nobody: string;
  /** The quick links; the first one is the section's own number. [list, label, as of now] */
  lists: [string, string, boolean?][];
}

const SECTIONS: Section[] = [
  {
    key: 'bookings',
    title: 'Bookings',
    kind: 'booking',
    by: 'By salesperson',
    nobody: 'Nobody assigned',
    lists: [
      ['bookings_confirmed', 'Confirmed'],
      ['bookings_waiting', 'Waiting for your approval', true],
      ['bookings_progress', 'Not yet confirmed', true],
      ['bookings_cancelled', 'Cancelled'],
    ],
  },
  {
    key: 'negotiations',
    title: 'Negotiations',
    kind: 'lead',
    by: 'By salesperson',
    nobody: 'Nobody assigned',
    lists: [
      ['negotiation_all', 'All open', true],
      ['negotiation_moving', 'Active', true],
      ['negotiation_quiet', `Quiet ${QUIET_DAYS}+ days`, true],
      ['negotiation_unassigned', 'Nobody assigned', true],
    ],
  },
  {
    key: 'completed',
    title: 'Site visits completed',
    kind: 'visit',
    by: 'Who took the visits',
    nobody: 'Not recorded',
    lists: [
      ['completed_all', 'All'],
      ['completed_very', 'Very interested'],
      ['completed_interested', 'Interested'],
      ['completed_low', 'Not interested'],
      ['completed_unrated', 'No rating'],
      ['completed_walkin', 'Walk-in and direct'],
    ],
  },
  {
    key: 'scheduled',
    title: 'Site visits scheduled',
    kind: 'visit',
    by: 'Who is going',
    nobody: 'Nobody yet',
    lists: [
      ['scheduled_all', 'All'],
      ['scheduled_upcoming', 'Still to come'],
      ['scheduled_done', 'Done'],
      ['scheduled_missed', 'Not updated'],
    ],
  },
];
/** Who booked the visits, by the day of booking. */
const BOOKED: Section = {
  key: 'booked',
  title: 'Site visits booked',
  kind: 'visit',
  by: 'Who booked site visits',
  nobody: 'Not recorded',
  lists: [['booked_all', 'Booked']],
};

const inRange = (r: { start: Date; end: Date }) => ({ gte: r.start, lt: r.end });
/** A walk-in was never scheduled; a cancelled visit is not counted. */
const scheduledWhere = (r: { start: Date; end: Date }): Prisma.SiteVisitBookingWhereInput => ({
  visit_type: { in: ['SCHEDULED', 'DIRECT'] },
  status: { not: 'CANCELLED' },
  scheduled_date: inRange(r),
});

/**
 * The days charted under a number: the period's own days (14 at most), or the days around a single
 * day. `ahead`: days still to come belong too (scheduled visits).
 */
function chartDays(x: Picked, now: Date, ahead: boolean): string[] {
  const today = istDate(now);
  const own = x.isAll ? [] : daysIn(x.period.start, x.period.end);
  if (own.length > 1 && own.length <= 14) return own;
  if (own.length > 14) {
    const at = own.indexOf(today);
    const anchor = at >= 0 ? at : own.length - 1;
    const from = Math.min(Math.max(anchor - (ahead ? 6 : 13), 0), own.length - 14);
    return own.slice(from, from + 14);
  }
  const centre = istMidnight(own[0] || today).getTime();
  const [back, count] = x.isAll ? [ahead ? 6 : 13, 14] : [ahead ? 3 : 6, 7];
  return Array.from({ length: count }, (_, i) => istDate(new Date(centre + (i - back) * DAY_MS)));
}

/** Per-day numbers: each day equals the list that day's bar opens. */
async function trends(companyIds: number[], x: Picked, now: Date) {
  const lead = { company_id: { in: companyIds } };
  const past = chartDays(x, now, false);
  const around = chartDays(x, now, true);
  const span = (days: string[]) => ({
    start: istMidnight(days[0]),
    end: new Date(istMidnight(days[days.length - 1]).getTime() + DAY_MS),
  });
  const soFar = (r: { start: Date; end: Date }) => ({
    start: r.start,
    end: new Date(Math.min(r.end.getTime(), now.getTime() + 1)),
  });
  const [deals, done, dated] = await Promise.all([
    dealsIn(companyIds, soFar(span(past))),
    p.siteVisitBooking.findMany({
      where: { lead, ...visitDoneWhere(soFar(span(past))) },
      select: { completed_at: true },
    }),
    p.siteVisitBooking.findMany({
      where: { lead, ...scheduledWhere(span(around)) },
      select: { scheduled_date: true },
    }),
  ]);
  const series = (days: string[], dates: (Date | null)[]) => {
    const n = new Map<string, number>();
    for (const d of dates) if (d) n.set(istDate(d), (n.get(istDate(d)) || 0) + 1);
    return days.map((day) => ({ day, count: n.get(day) || 0 }));
  };
  return {
    bookings: series(
      past,
      deals.map((d) => d.confirmed_at),
    ),
    completed: series(
      past,
      done.map((v) => v.completed_at),
    ),
    scheduled: series(
      around,
      dated.map((v) => v.scheduled_date),
    ),
  } as Record<string, { day: string; count: number }[]>;
}

interface Row {
  id: number;
  person: number | null;
}

/** Every list behind the dashboard, as record ids with the person each belongs to. */
async function mdRows(companyIds: number[], x: Picked, now: Date) {
  const co = { company_id: { in: companyIds } };
  const lead = { company_id: { in: companyIds } };
  const visitSelect = {
    id: true,
    status: true,
    rating: true,
    scheduled_date: true,
    telecaller_id: true,
    assigned_agent_id: true,
    project_manager_id: true,
  };

  const [deals, open, cancelled] = await Promise.all([
    dealsIn(companyIds, x.happened),
    p.booking.findMany({
      where: { ...co, status: { notIn: [...DEAL_STATUSES, 'CANCELLED'] } },
      select: { id: true, form_status: true, assigned_employee_id: true },
    }),
    p.booking.findMany({
      where: {
        ...co,
        status: 'CANCELLED',
        ...(x.isAll ? {} : { updated_at: inRange(x.happened) }),
      },
      select: { id: true, assigned_employee_id: true },
    }),
  ]);
  const ids = companyIds.length ? companyIds : [0];
  const [negotiation, completed, others, dated, booked] = await Promise.all([
    p.lead.findMany({
      where: { company_id: { in: ids }, status: 'NEGOTIATION' },
      select: {
        id: true,
        assigned_to_id: true,
        cp_owner_id: true,
        created_at: true,
        activities: { orderBy: { created_at: 'desc' }, take: 1, select: { created_at: true } },
      },
    }),
    p.siteVisitBooking.findMany({
      where: { lead, ...visitDoneWhere(x.happened) },
      select: visitSelect,
    }),
    p.siteVisitBooking.findMany({
      where: {
        lead,
        status: 'COMPLETED',
        visit_type: { not: 'SCHEDULED' },
        completed_at: inRange(x.happened),
      },
      select: visitSelect,
    }),
    p.siteVisitBooking.findMany({
      where: { lead, ...scheduledWhere(x.dated) },
      select: visitSelect,
    }),
    p.siteVisitBooking.findMany({
      where: { lead, ...visitBookedWhere(x.happened) },
      select: visitSelect,
    }),
  ]);

  type Visit = (typeof dated)[number];
  const going = (v: Visit): Row => ({
    id: v.id,
    person: v.assigned_agent_id ?? v.project_manager_id,
  });
  const booking = (b: { id: number; assigned_employee_id: number | null }): Row => ({
    id: b.id,
    person: b.assigned_employee_id,
  });
  const owner = (l: (typeof negotiation)[number]): Row => ({ id: l.id, person: l.assigned_to_id });
  const cut = now.getTime() - QUIET_DAYS * DAY_MS;
  const quiet = (l: (typeof negotiation)[number]) =>
    (l.activities[0]?.created_at ?? l.created_at).getTime() < cut;
  const isDone = (v: Visit) => v.status === 'COMPLETED';
  const coming = (v: Visit) => v.scheduled_date.getTime() >= now.getTime();

  const lists: Record<string, Row[]> = {
    bookings_confirmed: deals.map((d) => ({ id: d.id, person: d.assigned_employee_id })),
    bookings_waiting: open.filter((b) => b.form_status === 'SUBMITTED').map(booking),
    bookings_progress: open.filter((b) => b.form_status !== 'SUBMITTED').map(booking),
    bookings_cancelled: cancelled.map(booking),
    negotiation_all: negotiation.map(owner),
    negotiation_moving: negotiation.filter((l) => !quiet(l)).map(owner),
    negotiation_quiet: negotiation.filter(quiet).map(owner),
    // A channel partner's own customer is not waiting for an owner of ours.
    negotiation_unassigned: negotiation
      .filter((l) => !l.assigned_to_id && !l.cp_owner_id)
      .map(owner),
    completed_all: completed.map(going),
    completed_very: completed.filter((v) => v.rating === 'HOT_INTERESTED').map(going),
    completed_interested: completed.filter((v) => v.rating === 'WARM').map(going),
    completed_low: completed
      .filter((v) => v.rating === 'COLD' || v.rating === 'NOT_INTERESTED')
      .map(going),
    completed_unrated: completed.filter((v) => !v.rating).map(going),
    completed_walkin: others.map(going),
    scheduled_all: dated.map(going),
    scheduled_upcoming: dated.filter((v) => !isDone(v) && coming(v)).map(going),
    scheduled_done: dated.filter(isDone).map(going),
    scheduled_missed: dated.filter((v) => !isDone(v) && !coming(v)).map(going),
    booked_all: booked.map((v) => ({ id: v.id, person: v.telecaller_id })),
  };
  return {
    lists,
    salesValue: dealTotals(deals).value,
    quietIds: new Set(lists.negotiation_quiet.map((r) => r.id)),
    doneIds: new Set(booked.filter(isDone).map((v) => v.id)),
  };
}

async function namesOf(rows: Row[]) {
  const ids = [...new Set(rows.map((r) => r.person).filter((i): i is number => i !== null))];
  const people = await p.employee.findMany({
    where: { id: { in: ids } },
    select: { id: true, full_name: true, employee_code: true },
  });
  return new Map(people.map((e) => [e.id, nameOf(e)]));
}

/** Rows grouped by person, most first. `extra` counts the rows of each person that are in `marked`. */
function byPerson(rows: Row[], names: Map<number, string>, nobody: string, marked?: Set<number>) {
  const map = new Map<number | null, { count: number; extra: number }>();
  for (const r of rows) {
    const cur = map.get(r.person) || { count: 0, extra: 0 };
    cur.count++;
    if (marked?.has(r.id)) cur.extra++;
    map.set(r.person, cur);
  }
  return [...map.entries()]
    .map(([id, v]) => ({
      id: id === null ? 'none' : String(id),
      name: id === null ? nobody : names.get(id) || `#${id}`,
      ...v,
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export async function mdGlance(user: TokenPayload, query: MdQuery, now: Date = new Date()) {
  const x = pickPeriod(query, now);
  const companyIds = await getAccessibleCompanyIds(user);
  const prev = before(x, now);
  const [data, perDay, prevDeals, prevDone] = await Promise.all([
    mdRows(companyIds, x, now),
    trends(companyIds, x, now),
    prev ? dealsIn(companyIds, prev) : null,
    prev
      ? p.siteVisitBooking.count({
          where: { lead: { company_id: { in: companyIds } }, ...visitDoneWhere(prev) },
        })
      : null,
  ]);
  const { lists } = data;
  const names = await namesOf(Object.values(lists).flat());

  const sections = SECTIONS.map((s) => {
    const main = lists[s.lists[0][0]];
    const marked = s.key === 'negotiations' ? data.quietIds : undefined;
    return {
      key: s.key,
      title: s.title,
      kind: s.kind,
      by: s.by,
      total: main.length,
      previous:
        s.key === 'bookings'
          ? (prevDeals?.length ?? null)
          : s.key === 'completed'
            ? prevDone
            : null,
      value: s.key === 'bookings' ? data.salesValue : null,
      /** True when the section's own number is what is open now, whatever the dates. */
      now: !!s.lists[0][2],
      tabs: s.lists.map(([list, label, asOfNow]) => ({
        list,
        label,
        now: !!asOfNow,
        count: lists[list].length,
      })),
      people: byPerson(main, names, s.nobody, marked),
      /** Null where there is nothing to chart by day (negotiations are as of now). */
      trend: perDay[s.key] || null,
    };
  });

  return {
    generated_at: now.toISOString(),
    today: istDate(now),
    period: {
      key: x.key,
      label: x.label,
      range_label: x.rangeLabel,
      compare: !x.isAll,
    },
    sections,
    booked: {
      total: lists.booked_all.length,
      people: byPerson(lists.booked_all, names, BOOKED.nobody, data.doneIds),
    },
  };
}

/** The records behind one number: what the page it opens must show. */
export async function mdList(user: TokenPayload, query: MdQuery, now: Date = new Date()) {
  if (!user.roles.some((r) => r === Roles.MD || r === Roles.ADMIN)) {
    const message = 'Only the Managing Director and Admin can open this list.';
    throw { status: 403, statusCode: 403, message };
  }
  const section = [...SECTIONS, BOOKED].find((s) => s.lists.some(([l]) => l === query.md));
  if (!section) throw { status: 400, statusCode: 400, message: 'Unknown list' };
  const [list, label, asOfNow] = section.lists.find(([l]) => l === query.md)!;
  const x = pickPeriod(query, now);
  const { lists } = await mdRows(await getAccessibleCompanyIds(user), x, now);
  const person = typeof query.person === 'string' ? query.person : '';
  const rows = person
    ? lists[list].filter((r) => (r.person === null ? 'none' : String(r.person)) === person)
    : lists[list];
  const personName =
    person && person !== 'none'
      ? (await namesOf([{ id: 0, person: Number(person) || 0 }])).get(Number(person)) || ''
      : person
        ? section.nobody
        : '';
  const title = [
    section.title,
    section.lists.length > 1 && list !== section.lists[0][0] ? label : '',
    asOfNow ? 'open now' : x.label,
    personName,
  ]
    .filter(Boolean)
    .join(' · ');
  return { list, kind: section.kind, title, ids: rows.map((r) => r.id) };
}
