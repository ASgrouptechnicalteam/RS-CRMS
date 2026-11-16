import { prisma } from '../lib/prisma';
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
  // Item 1 (2026-11-15): digital work per platform, from the work log.
  'POSTS_INSTAGRAM',
  'POSTS_FACEBOOK',
  'POSTS_YOUTUBE',
  'POSTS_PINTEREST',
  'POSTS_LINKEDIN',
  'WHATSAPP_QUOTES',
] as const;
export const TARGET_PERIODS = ['DAY', 'WEEK', 'MONTH'] as const;
export type TargetMetric = (typeof TARGET_METRICS)[number];
export type TargetPeriod = (typeof TARGET_PERIODS)[number];

export const METRIC_LABELS: Record<TargetMetric, string> = {
  CALLS: 'Calls made',
  VISITS_BOOKED: 'Site visits booked',
  VISITS_COMPLETED: 'Site visits completed',
  BOOKINGS_CONFIRMED: 'Bookings confirmed',
  DRAFTS_READY: 'Drafts ready in CRM',
  POSTS_INSTAGRAM: 'Instagram posts and reels',
  POSTS_FACEBOOK: 'Facebook posts and reels',
  POSTS_YOUTUBE: 'YouTube videos and shorts',
  POSTS_PINTEREST: 'Pinterest pins',
  POSTS_LINKEDIN: 'LinkedIn posts',
  WHATSAPP_QUOTES: 'WhatsApp quote images',
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
    case 'DRAFTS_READY':
      return p.draftSubmission.count({
        where: {
          submitted_by: employeeId,
          status: 'READY_IN_CRM',
          ready_at: { gte: start, lt: end },
        },
      });
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

export interface TargetProgress {
  metric: TargetMetric;
  metric_label: string;
  period: TargetPeriod;
  target: number;
  done: number;
  percent: number;
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
  for (const t of chosen.values()) {
    const range = periodRange(t.period as TargetPeriod, now);
    const done = await measureMetric(employee.id, t.metric as TargetMetric, range.start, range.end);
    out.push({
      metric: t.metric as TargetMetric,
      metric_label: METRIC_LABELS[t.metric as TargetMetric] || t.metric,
      period: t.period as TargetPeriod,
      target: t.value,
      done,
      percent: t.value > 0 ? Math.min(100, Math.round((done / t.value) * 100)) : 0,
      source: t.employee_id ? 'PERSON' : 'ROLE',
      target_id: t.id,
      range_start: range.start.toISOString(),
      range_end: range.end.toISOString(),
    });
  }
  const order = { DAY: 0, WEEK: 1, MONTH: 2 } as const;
  return out.sort((a, b) => order[a.period] - order[b.period] || a.metric.localeCompare(b.metric));
}
