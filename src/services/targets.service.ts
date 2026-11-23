import { prisma } from '../lib/prisma';
import { associateWork } from './associateWork';
import { getISTComponents, getISTDayOfWeek, toHolidayDateKey } from '../utils/time';
import { periodContaining } from './counts/period';
import { DEAL_STATUSES } from './counts/deals';
import { PLATFORM_KINDS, Platform, WORK_LOG_ACTION, parseWorkLog } from '../routes/workLog';
import {
  bookingIdsConfirmedIn,
  visitBookedWhere,
  visitDoneBy,
  visitDoneWhere,
} from './counts/metrics';

const p = prisma;

export const TARGET_METRICS = [
  'CALLS',
  'VISITS_BOOKED',
  'VISITS_COMPLETED',
  'BOOKINGS_CONFIRMED',
  'DRAFTS_READY',
  'DRAFTS_SUBMITTED',
  'DRAFTS_FINISHED',
  // Item 1 (2026-11-15): digital work per platform, from the work log.
  'POSTS_INSTAGRAM',
  'POSTS_FACEBOOK',
  'POSTS_YOUTUBE',
  'POSTS_PINTEREST',
  'POSTS_LINKEDIN',
  'WHATSAPP_QUOTES',
  // Added 2026-11-21 so every kind of work can have a target. All counted from system records.
  'NEW_CALLS',
  'FOLLOWUP_CALLS',
  'LEADS_WORKED',
  'VISITS_DONE_FOR_LEADS',
  'TASKS_DONE',
  'LISTINGS_ADDED',
  'CODE_UPDATES',
  'APPROVALS_DONE',
  'FINANCE_ENTRIES',
  'PEOPLE_ACTIONS',
  'LISTING_EDITS',
  'MASTER_DATA_ACTIONS',
  // Added 2026-11-23: the Channel Partner Manager's work with associates, from the Associates page.
  'ASSOCIATE_CALLS',
  'NEW_ASSOCIATE_CALLS',
  'ASSOCIATES_AGREED',
  'ASSOCIATES_ONBOARDED',
  'ASSOCIATE_OFFICE_VISITS',
  'ASSOCIATE_LEADS',
  'ASSOCIATE_VISITS_BOOKED',
] as const;
export const TARGET_PERIODS = ['DAY', 'WEEK', 'MONTH'] as const;
export type TargetMetric = (typeof TARGET_METRICS)[number];
export type TargetPeriod = (typeof TARGET_PERIODS)[number];

export const METRIC_LABELS: Record<TargetMetric, string> = {
  CALLS: 'Calls made',
  VISITS_BOOKED: 'Site visits booked',
  VISITS_COMPLETED: 'Site visits completed',
  BOOKINGS_CONFIRMED: 'Bookings confirmed',
  DRAFTS_READY: 'My submitted drafts that reached Ready in CRM',
  DRAFTS_SUBMITTED: 'New listings I submitted (property or project)',
  DRAFTS_FINISHED: 'Drafts I finished in the CRM (digital team)',
  POSTS_INSTAGRAM: 'Instagram posts and reels',
  POSTS_FACEBOOK: 'Facebook posts and reels',
  POSTS_YOUTUBE: 'YouTube videos and shorts',
  POSTS_PINTEREST: 'Pinterest pins',
  POSTS_LINKEDIN: 'LinkedIn posts',
  WHATSAPP_QUOTES: 'WhatsApp quote images',
  NEW_CALLS: 'New calls (first call on a lead)',
  FOLLOWUP_CALLS: 'Follow-up calls',
  LEADS_WORKED: 'Different leads worked',
  VISITS_DONE_FOR_LEADS: 'Site visits of my leads completed',
  TASKS_DONE: 'Tasks completed',
  LISTINGS_ADDED: 'Properties added',
  CODE_UPDATES: 'Code updates (GitHub commits)',
  APPROVALS_DONE: 'Approvals and rejections decided',
  FINANCE_ENTRIES: 'Finance entries (expenses, payments, petty cash)',
  PEOPLE_ACTIONS: 'People and attendance actions (HR)',
  LISTING_EDITS: 'Property and project edits',
  MASTER_DATA_ACTIONS: 'Master data actions',
  ASSOCIATE_CALLS: 'Calls to associates',
  NEW_ASSOCIATE_CALLS: 'Calls to new associates (not joined yet)',
  ASSOCIATES_AGREED: 'Associates who agreed to work with us',
  ASSOCIATES_ONBOARDED: 'Associates onboarded',
  ASSOCIATE_OFFICE_VISITS: 'Associate office visits',
  ASSOCIATE_LEADS: 'Leads added from associates',
  ASSOCIATE_VISITS_BOOKED: 'Site visits booked for associates’ customers',
};

const G_CALL = 'Calling (Telecaller, Sales Manager, Agent, every role)';
const G_SITE = 'Site visits and bookings (Telecaller, Project Manager)';
const G_DATA = 'Listings and data (Project Manager, Inventory, Data Entry, Technical Manager)';
const G_DIGI = 'Digital team (from the work log)';
const G_MGMT = 'Management, HR and Finance';
const G_ASSOC = 'Associates (Channel Partner Manager)';

/** Which kind of work each measure suits, so the setting screen can group them. */
export const METRIC_GROUPS: Record<TargetMetric, string> = {
  CALLS: G_CALL,
  NEW_CALLS: G_CALL,
  FOLLOWUP_CALLS: G_CALL,
  LEADS_WORKED: G_CALL,
  VISITS_BOOKED: G_SITE,
  VISITS_COMPLETED: G_SITE,
  VISITS_DONE_FOR_LEADS: G_SITE,
  BOOKINGS_CONFIRMED: G_SITE,
  LISTINGS_ADDED: G_DATA,
  LISTING_EDITS: G_DATA,
  MASTER_DATA_ACTIONS: G_DATA,
  DRAFTS_READY: G_DATA,
  DRAFTS_SUBMITTED: G_DATA,
  DRAFTS_FINISHED: G_DATA,
  CODE_UPDATES: G_DATA,
  POSTS_INSTAGRAM: G_DIGI,
  POSTS_FACEBOOK: G_DIGI,
  POSTS_YOUTUBE: G_DIGI,
  POSTS_PINTEREST: G_DIGI,
  POSTS_LINKEDIN: G_DIGI,
  WHATSAPP_QUOTES: G_DIGI,
  APPROVALS_DONE: G_MGMT,
  FINANCE_ENTRIES: G_MGMT,
  PEOPLE_ACTIONS: G_MGMT,
  TASKS_DONE: G_MGMT,
  ASSOCIATE_CALLS: G_ASSOC,
  NEW_ASSOCIATE_CALLS: G_ASSOC,
  ASSOCIATES_AGREED: G_ASSOC,
  ASSOCIATES_ONBOARDED: G_ASSOC,
  ASSOCIATE_OFFICE_VISITS: G_ASSOC,
  ASSOCIATE_LEADS: G_ASSOC,
  ASSOCIATE_VISITS_BOOKED: G_ASSOC,
};

/** Target metric -> the work-log platform it counts. */
export const PLATFORM_METRICS: Record<string, Platform> = {
  POSTS_INSTAGRAM: 'INSTAGRAM',
  POSTS_FACEBOOK: 'FACEBOOK',
  POSTS_YOUTUBE: 'YOUTUBE',
  POSTS_PINTEREST: 'PINTEREST',
  POSTS_LINKEDIN: 'LINKEDIN',
  WHATSAPP_QUOTES: 'WHATSAPP_IMAGES',
};

/**
 * The IST window for a period: the day, the week (Monday to the next Monday) or
 * the calendar month containing `now`. End is exclusive. (services/counts/period.ts)
 */
export function periodRange(period: TargetPeriod, now: Date = new Date()) {
  const { start, end } = periodContaining(period, now);
  return { start, end };
}

/**
 * What the system recorded for one person in [start, end). Never typed.
 *  - CALLS: logged call attempts.
 *  - VISITS_BOOKED: visits this person booked (walk-ins are not "booked"; cancelled ones do not count).
 *  - VISITS_COMPLETED: visits this person ran (the agent, else the project manager), by the day they were completed.
 *  - BOOKINGS_CONFIRMED: bookings credited to this person, by the day the booking was confirmed.
 *  - DRAFTS_READY: drafts this person submitted that reached Ready in CRM, by the day they got there.
 *  - DRAFTS_SUBMITTED: new listings (property or project drafts) this person sent to the digital team, by the day sent.
 *  - DRAFTS_FINISHED: drafts this person picked up and linked to the real record (Ready in CRM), by that day.
 *    Submitting or being picked up earns nothing, so a junk draft cannot count.
 */
export async function measureMetric(
  employeeId: number,
  metric: TargetMetric,
  start: Date,
  end: Date,
): Promise<number> {
  const platform = PLATFORM_METRICS[metric];
  if (platform) {
    // Sum of the count on this person's work-log entries for that platform
    // (index AuditEvent[actor_id, action, created_at]).
    const rows = await p.auditEvent.findMany({
      where: { actor_id: employeeId, action: WORK_LOG_ACTION, created_at: { gte: start, lt: end } },
      select: { id: true, new_value: true, created_at: true },
    });
    const kinds: readonly string[] = PLATFORM_KINDS[platform];
    return rows
      .map(parseWorkLog)
      .filter((e) => e && kinds.includes(e.kind))
      .reduce((n, e) => n + (e?.count || 0), 0);
  }
  switch (metric) {
    case 'CALLS':
      return p.leadActivity.count({
        where: {
          actor_id: employeeId,
          activity_type: 'CALL_LOGGED',
          created_at: { gte: start, lt: end },
        },
      });
    case 'VISITS_BOOKED':
      return p.siteVisitBooking.count({
        where: { telecaller_id: employeeId, ...visitBookedWhere({ start, end }) },
      });
    case 'VISITS_COMPLETED':
      return p.siteVisitBooking.count({
        where: { ...visitDoneWhere({ start, end }), ...visitDoneBy(employeeId) },
      });
    case 'NEW_CALLS':
    case 'FOLLOWUP_CALLS': {
      const calls = await p.leadActivity.findMany({
        where: {
          actor_id: employeeId,
          activity_type: 'CALL_LOGGED',
          created_at: { gte: start, lt: end },
        },
        select: { lead_id: true },
        take: 20000,
      });
      const leadIds = [...new Set(calls.map((c) => c.lead_id))];
      // A "new" call is the first call ever made to a lead, credited to whoever made it,
      // and it counts only in the period when that first call was made.
      let firstMine = 0;
      if (leadIds.length) {
        const history = await p.leadActivity.findMany({
          where: {
            lead_id: { in: leadIds },
            activity_type: 'CALL_LOGGED',
            created_at: { lt: end },
          },
          select: { lead_id: true, actor_id: true, created_at: true },
          orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
        });
        const first = new Map<number, { actor: number; at: Date }>();
        for (const h of history)
          if (!first.has(h.lead_id)) first.set(h.lead_id, { actor: h.actor_id, at: h.created_at });
        firstMine = leadIds.filter((id) => {
          const f = first.get(id);
          return !!f && f.actor === employeeId && f.at >= start && f.at < end;
        }).length;
      }
      return metric === 'NEW_CALLS' ? firstMine : calls.length - firstMine;
    }
    case 'LEADS_WORKED': {
      const rows = await p.leadActivity.findMany({
        where: {
          actor_id: employeeId,
          created_at: { gte: start, lt: end },
          activity_type: { notIn: ['LEAD_CREATED', 'ASSIGNED_TO_AGENT', 'ASSOCIATE_REPORT'] },
        },
        select: { lead_id: true },
        distinct: ['lead_id'],
      });
      return rows.length;
    }
    case 'VISITS_DONE_FOR_LEADS':
      return p.siteVisitBooking.count({
        where: {
          telecaller_id: employeeId,
          status: 'COMPLETED',
          completed_at: { gte: start, lt: end },
        },
      });
    case 'TASKS_DONE':
      return p.task.count({
        where: {
          assignee_id: employeeId,
          status: 'COMPLETED',
          completed_at: { gte: start, lt: end },
        },
      });
    case 'LISTINGS_ADDED':
      return p.property.count({
        where: { created_by_id: employeeId, created_at: { gte: start, lt: end } },
      });
    case 'CODE_UPDATES':
      return p.codeUpdate.count({
        where: { employee_id: employeeId, committed_at: { gte: start, lt: end } },
      });
    case 'APPROVALS_DONE':
    case 'FINANCE_ENTRIES':
    case 'PEOPLE_ACTIONS':
    case 'LISTING_EDITS':
    case 'MASTER_DATA_ACTIONS': {
      // Changes recorded in the CRM, sorted by what they were about (the same grouping as Team Today).
      const { crmActionGroup } = await import('../routes/md');
      const { CRM_ACTION } = await import('../middleware/recordCrmAction');
      const group = {
        APPROVALS_DONE: 'APPROVALS',
        FINANCE_ENTRIES: 'FINANCE',
        PEOPLE_ACTIONS: 'PEOPLE',
        LISTING_EDITS: 'LISTINGS',
        MASTER_DATA_ACTIONS: 'MASTER_DATA',
      }[metric];
      const rows = await p.auditEvent.findMany({
        where: { actor_id: employeeId, action: CRM_ACTION, created_at: { gte: start, lt: end } },
        select: { new_value: true },
        take: 20000,
      });
      let n = 0;
      for (const r of rows) {
        try {
          const v = JSON.parse(r.new_value || '{}');
          if (crmActionGroup(v.method || '', v.path || '') === group) n++;
        } catch {
          // not a recorded request
        }
      }
      return n;
    }
    case 'DRAFTS_SUBMITTED':
      return p.draftSubmission.count({
        where: { submitted_by: employeeId, created_at: { gte: start, lt: end } },
      });
    case 'DRAFTS_FINISHED':
      return p.draftSubmission.count({
        where: {
          picked_by: employeeId,
          status: 'READY_IN_CRM',
          ready_at: { gte: start, lt: end },
        },
      });
    case 'DRAFTS_READY':
      return p.draftSubmission.count({
        where: {
          submitted_by: employeeId,
          status: 'READY_IN_CRM',
          ready_at: { gte: start, lt: end },
        },
      });
    case 'ASSOCIATE_CALLS':
    case 'NEW_ASSOCIATE_CALLS':
    case 'ASSOCIATES_AGREED':
    case 'ASSOCIATES_ONBOARDED':
    case 'ASSOCIATE_OFFICE_VISITS':
    case 'ASSOCIATE_LEADS':
    case 'ASSOCIATE_VISITS_BOOKED': {
      const w = await associateWork(employeeId, { start, end });
      return {
        ASSOCIATE_CALLS: w.calls,
        NEW_ASSOCIATE_CALLS: w.new_calls,
        ASSOCIATES_AGREED: w.agreed,
        ASSOCIATES_ONBOARDED: w.enrolled,
        ASSOCIATE_OFFICE_VISITS: w.office_visits,
        ASSOCIATE_LEADS: w.leads,
        ASSOCIATE_VISITS_BOOKED: w.visits_booked,
      }[metric];
    }
    case 'BOOKINGS_CONFIRMED': {
      const ids = [...(await bookingIdsConfirmedIn({ start, end })).keys()];
      if (ids.length === 0) return 0;
      return p.booking.count({
        where: { id: { in: ids }, assigned_employee_id: employeeId, status: { in: DEAL_STATUSES } },
      });
    }
    default:
      return 0;
  }
}

/**
 * How much of a normal week or month this person could work (owner, 2026-11-21): days off
 * (company holidays, their week off, swaps, comp-offs) and approved leave (half a day for a
 * half-day leave) shrink the target in the same proportion. A duty day on an off day counts as
 * worked. `factor` is never above 1; when `available` is 0 the period is not judged at all.
 */
export async function workShare(
  employee: { id: number; company_id: number; weekly_off_day: number | null },
  start: Date,
  end: Date,
) {
  const days: string[] = [];
  for (let t = start.getTime(); t < end.getTime(); t += 86400000) {
    days.push(getISTComponents(new Date(t + 12 * 3600 * 1000)).dateString);
  }
  const [holidays, requests] = await Promise.all([
    p.companyHoliday.findMany({
      where: {
        company_id: employee.company_id,
        date: { gte: toHolidayDateKey(days[0]), lte: toHolidayDateKey(days[days.length - 1]) },
      },
      select: { date: true },
    }),
    p.attendanceProposal.findMany({
      where: {
        employee_id: employee.id,
        status: 'APPROVED',
        type: { in: ['LEAVE', 'DUTY_DAY', 'SWAP_OFF', 'COMP_OFF'] },
        target_date: { gte: start, lt: end },
      },
      select: { type: true, leave_type: true, target_date: true },
    }),
  ]);
  const holidayDays = new Set(holidays.map((h) => h.date.toISOString().slice(0, 10)));
  const dayOf = (d: Date) => getISTComponents(d).dateString;
  let normal = 0;
  let available = 0;
  for (const day of days) {
    const weekOff =
      employee.weekly_off_day !== null && employee.weekly_off_day === getISTDayOfWeek(day);
    if (!weekOff) normal += 1;
    const mine = requests.filter((r) => dayOf(r.target_date) === day);
    const duty = mine.some((r) => r.type === 'DUTY_DAY');
    const off =
      (holidayDays.has(day) ||
        weekOff ||
        mine.some((r) => r.type === 'SWAP_OFF' || r.type === 'COMP_OFF')) &&
      !duty;
    if (off) continue;
    const leave = mine.find((r) => r.type === 'LEAVE');
    available += leave ? (leave.leave_type === 'FULL_DAY' ? 0 : 0.5) : 1;
  }
  const factor = normal > 0 ? Math.min(1, available / normal) : 1;
  return { normal, available, factor };
}

/** The target for a week or month after the days the person could not work are taken off (never below 1). */
export function scaledTarget(value: number, factor: number) {
  return factor >= 1 ? value : Math.max(1, Math.round(value * factor));
}

export interface TargetProgress {
  metric: TargetMetric;
  metric_label: string;
  period: TargetPeriod;
  target: number;
  done: number;
  percent: number;
  /** Set when the target was lowered for leave and days off. */
  full_target?: number;
  source: 'PERSON' | 'ROLE';
  target_id: number;
  range_start: string;
  range_end: string;
}

/**
 * The targets that apply to this person in the period containing `now`, with
 * progress. A person's own target replaces their role's for the same
 * metric+period; someone with several roles gets the highest role value.
 * A target set mid-period counts the whole period's activity (no pro-rating
 * for leave and holidays yet); one whose dates have not started or have ended
 * is not shown.
 */
type TargetRow = {
  id: number;
  employee_id: number | null;
  role_name: string | null;
  metric: string;
  period: string;
  value: number;
  valid_from: Date;
  valid_to: Date | null;
};

/**
 * Which of these target rows apply to one person now: a person's own target
 * replaces their role's for the same metric+period; several roles take the
 * highest. Rows must already be limited to this person and their roles.
 */
export function chooseTargets<T extends TargetRow>(rows: T[], employeeId: number, now: Date) {
  const chosen = new Map<string, T>();
  for (const t of rows) {
    if (t.employee_id && t.employee_id !== employeeId) continue;
    const range = periodRange(t.period as TargetPeriod, now);
    const started = t.valid_from.getTime() < range.end.getTime();
    const notEnded = !t.valid_to || t.valid_to.getTime() >= range.start.getTime();
    if (!started || !notEnded) continue;
    const key = `${t.metric}|${t.period}`;
    const cur = chosen.get(key);
    if (
      !cur ||
      (t.employee_id && !cur.employee_id) ||
      (!!t.employee_id === !!cur.employee_id && t.value > cur.value)
    ) {
      chosen.set(key, t);
    }
  }
  return chosen;
}

export async function progressFor(
  employee: { id: number; company_id: number; roles: string[] },
  now: Date = new Date(),
): Promise<TargetProgress[]> {
  const rows = await p.performanceTarget.findMany({
    where: {
      company_id: employee.company_id,
      is_active: true,
      OR: [{ employee_id: employee.id }, { employee_id: null, role_name: { in: employee.roles } }],
    },
  });

  const chosen = chooseTargets(rows, employee.id, now);

  const out: TargetProgress[] = [];
  const person = await p.employee.findUnique({
    where: { id: employee.id },
    select: { id: true, company_id: true, weekly_off_day: true },
  });
  for (const t of chosen.values()) {
    const range = periodRange(t.period as TargetPeriod, now);
    const done = await measureMetric(employee.id, t.metric as TargetMetric, range.start, range.end);
    // A week or month is lowered for leave and days off; a day is not.
    const share =
      person && t.period !== 'DAY' ? await workShare(person, range.start, range.end) : null;
    const value = share ? scaledTarget(t.value, share.factor) : t.value;
    out.push({
      metric: t.metric as TargetMetric,
      metric_label: METRIC_LABELS[t.metric as TargetMetric] || t.metric,
      period: t.period as TargetPeriod,
      target: value,
      done,
      percent: value > 0 ? Math.min(100, Math.round((done / value) * 100)) : 0,
      ...(value !== t.value ? { full_target: t.value } : {}),
      source: t.employee_id ? 'PERSON' : 'ROLE',
      target_id: t.id,
      range_start: range.start.toISOString(),
      range_end: range.end.toISOString(),
    });
  }
  const order = { DAY: 0, WEEK: 1, MONTH: 2 } as const;
  return out.sort((a, b) => order[a.period] - order[b.period] || a.metric.localeCompare(b.metric));
}
