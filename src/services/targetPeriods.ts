import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';
import { getISTComponents, getISTMidnightInstant } from '../utils/time';
import { dayInfoMany } from './workCalendar';
import {
  chooseTargets,
  measureMetric,
  periodRange,
  scaledTarget,
  workShare,
  type TargetMetric,
  type TargetPeriod,
} from './targets.service';

/**
 * Target results move the performance score (owner, 2026-11-21): a day's targets met
 * is +1 and missed -1, a week +3 / -3, a month +5 / -5. A period is "met" when every
 * target the person has for it is reached. Written once when the period ends, by a
 * night job, so reading the score never has to measure anything again.
 */
const p = prisma as any;

export const PERIOD_POINTS: Record<TargetPeriod, number> = { DAY: 1, WEEK: 3, MONTH: 5 };
export const PERIOD_ACTIONS = [
  'TARGET_DAY_MET',
  'TARGET_DAY_MISSED',
  'TARGET_WEEK_MET',
  'TARGET_WEEK_MISSED',
  'TARGET_MONTH_MET',
  'TARGET_MONTH_MISSED',
] as const;

const addDays = (date: string, n: number) =>
  getISTComponents(new Date(new Date(`${date}T12:00:00+05:30`).getTime() + n * 86400000))
    .dateString;

/** Which periods ended just before `now` (IST): yesterday, and the week or month that closed today. */
export function periodsEndedBefore(now: Date) {
  const today = getISTComponents(now).dateString;
  const yesterday = addDays(today, -1);
  const out: { period: TargetPeriod; inside: Date }[] = [
    { period: 'DAY', inside: new Date(`${yesterday}T12:00:00+05:30`) },
  ];
  // The week runs Monday to the next Monday: it closed when today is a Monday.
  if (new Date(`${today}T12:00:00+05:30`).getUTCDay() === 1) {
    out.push({ period: 'WEEK', inside: new Date(`${yesterday}T12:00:00+05:30`) });
  }
  if (today.endsWith('-01')) {
    out.push({ period: 'MONTH', inside: new Date(`${yesterday}T12:00:00+05:30`) });
  }
  return out;
}

/** Writes the day, week and month results that ended before `now`. Safe to run twice. */
export async function recordTargetResults(now: Date = new Date()) {
  const ended = periodsEndedBefore(now);
  const rows = await p.performanceTarget.findMany({ where: { is_active: true } });
  if (!rows.length) return { written: 0 };
  const people = await p.employee.findMany({
    where: {
      status: 'ACTIVE',
      deleted_at: null,
      attendance_required: true,
      OR: [
        { id: { in: rows.filter((r: any) => r.employee_id).map((r: any) => r.employee_id) } },
        {
          roles: {
            some: {
              role: {
                name: { in: rows.filter((r: any) => r.role_name).map((r: any) => r.role_name) },
              },
            },
          },
        },
      ],
    },
    select: {
      id: true,
      company_id: true,
      weekly_off_day: true,
      roles: { select: { role: { select: { name: true } } } },
    },
  });
  let written = 0;
  for (const { period, inside } of ended) {
    const range = periodRange(period, inside);
    const startKey = getISTComponents(range.start).dateString;
    const dayOff =
      period === 'DAY'
        ? await dayInfoMany(
            people.map((x: any) => ({
              id: x.id,
              company_id: x.company_id,
              weekly_off_day: x.weekly_off_day,
            })),
            startKey,
          )
        : null;
    for (const person of people) {
      const roles = person.roles.map((r: { role: { name: string } }) => r.role.name);
      const mine = rows.filter(
        (r: any) =>
          r.employee_id === person.id ||
          (r.employee_id === null &&
            r.company_id === person.company_id &&
            roles.includes(r.role_name)),
      );
      const targets = [...chooseTargets(mine, person.id, inside).values()].filter(
        (t: any) => t.period === period,
      );
      if (!targets.length) continue;

      // Not expected at work, or on approved leave: no result for that day.
      if (dayOff?.get(person.id)?.offDay) continue;
      if (period === 'DAY') {
        const leave = await p.attendanceProposal.count({
          where: {
            employee_id: person.id,
            type: 'LEAVE',
            status: 'APPROVED',
            target_date: { gte: range.start, lt: range.end },
          },
        });
        if (leave) continue;
      } else {
        // A week or month in which the person never came in is not judged.
        const came = await p.attendanceLog.count({
          where: { employee_id: person.id, check_in_at: { gte: range.start, lt: range.end } },
        });
        if (!came) continue;
      }

      // A week or month is judged against the target lowered for leave and days off.
      let factor = 1;
      if (period !== 'DAY') {
        const share = await workShare(person, range.start, range.end);
        if (share.available <= 0) continue;
        factor = share.factor;
      }
      let met = true;
      for (const t of targets) {
        const done = await measureMetric(
          person.id,
          t.metric as TargetMetric,
          range.start,
          range.end,
        );
        if (done < scaledTarget(t.value, factor)) {
          met = false;
          break;
        }
      }
      const action = `TARGET_${period}_${met ? 'MET' : 'MISSED'}`;
      const key = JSON.stringify({ date: startKey });
      const exists = await p.auditEvent.count({
        where: {
          actor_id: person.id,
          action: { in: [`TARGET_${period}_MET`, `TARGET_${period}_MISSED`] },
          new_value: key,
        },
      });
      if (exists) continue;
      await p.auditEvent.create({
        data: {
          actor_id: person.id,
          action,
          entity_type: 'EMPLOYEE',
          entity_id: person.id,
          new_value: key,
          reason: met
            ? `${period.toLowerCase()} target reached`
            : `${period.toLowerCase()} target not reached`,
        },
      });
      written++;
    }
  }
  if (written) logger.info(`[Targets] ${written} target result(s) recorded.`);
  return { written };
}

/**
 * The night job, with catch-up: if the server was asleep or restarting at 00:20, the missed
 * day, week or month is written the next night instead of being lost. Results already
 * written are skipped, so running over the last few days is safe (audit 2026-11-21).
 */
export async function recordRecentTargetResults(now: Date = new Date(), daysBack = 3) {
  let written = 0;
  for (let k = daysBack - 1; k >= 0; k--) {
    written += (await recordTargetResults(new Date(now.getTime() - k * 86400000))).written;
  }
  return { written };
}

export { getISTMidnightInstant };
