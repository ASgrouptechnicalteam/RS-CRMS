import { randomUUID } from 'crypto';
import { prisma } from '../lib/prisma';
import { getISTComponents } from '../utils/time';
import type { Prisma } from '@prisma/client';
import { dayInfo, dayInfoMany } from './workCalendar';
import { DAILY_ASSIGNMENT, uncalledAssigned } from './lead/masterLeads';

const p = prisma;

export interface PlanItem {
  id: string;
  text: string;
  kind: 'NOTE' | 'SITE_VISIT' | 'TASK';
  ref_id?: number | null;
  time?: string | null;
  done?: boolean;
}

const addDays = (date: string, n: number) =>
  getISTComponents(new Date(new Date(`${date}T12:00:00+05:30`).getTime() + n * 86400000))
    .dateString;
const dayRange = (date: string) => {
  const gte = new Date(`${date}T00:00:00+05:30`);
  return { gte, lt: new Date(gte.getTime() + 86400000) };
};
const timeOf = (d: Date) =>
  d.toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Kolkata',
  });

/** The next day this person is expected at work (Saturday's "tomorrow" may be Monday). */
export async function nextWorkDay(employeeId: number): Promise<string> {
  const today = getISTComponents(new Date()).dateString;
  const employee = await p.employee.findUnique({
    where: { id: employeeId },
    select: { id: true, company_id: true, weekly_off_day: true },
  });
  if (!employee) return addDays(today, 1);
  for (let n = 1; n <= 7; n++) {
    const date = addDays(today, n);
    if (!(await dayInfo(employee, date)).offDay) return date;
  }
  return addDays(today, 1);
}

/** Work already in the CRM for that day, which the person can add to the plan. */
async function scheduledFor(employeeId: number, date: string) {
  const range = dayRange(date);
  const [visits, tasks] = await Promise.all([
    p.siteVisitBooking.findMany({
      where: {
        scheduled_date: range,
        status: { notIn: ['COMPLETED', 'CANCELLED'] },
        OR: [
          { telecaller_id: employeeId },
          { project_manager_id: employeeId },
          { assigned_agent_id: employeeId },
        ],
      },
      select: {
        id: true,
        scheduled_date: true,
        lead: { select: { customer_name: true } },
        project: { select: { name: true } },
      },
      orderBy: { scheduled_date: 'asc' },
      take: 50,
    }),
    p.task.findMany({
      where: {
        assignee_id: employeeId,
        target_date: range,
        status: { notIn: ['COMPLETED', 'CANCELLED', 'NOT_COMPLETED', 'BLOCKED'] },
      },
      select: { id: true, title: true, target_date: true },
      orderBy: { target_date: 'asc' },
      take: 50,
    }),
  ]);
  return [
    ...visits.map((v) => ({
      kind: 'SITE_VISIT' as const,
      ref_id: v.id,
      time: timeOf(v.scheduled_date),
      text: `Site visit: ${v.lead?.customer_name || 'Customer'}${v.project ? `, ${v.project.name}` : ''}`,
    })),
    ...tasks.map((t) => ({
      kind: 'TASK' as const,
      ref_id: t.id,
      time: timeOf(t.target_date),
      text: t.title,
    })),
  ];
}

export async function getPlan(employeeId: number, date: string) {
  const plan = await p.dayPlan.findUnique({
    where: { employee_id_plan_date: { employee_id: employeeId, plan_date: date } },
  });
  return { date, items: (plan?.items as unknown as PlanItem[]) || [], saved: !!plan };
}

export async function getTomorrow(employeeId: number) {
  const date = await nextWorkDay(employeeId);
  const [plan, scheduled] = await Promise.all([
    getPlan(employeeId, date),
    scheduledFor(employeeId, date),
  ]);
  return { ...plan, scheduled };
}

export async function saveTomorrow(
  employeeId: number,
  items: {
    id?: string;
    text: string;
    kind?: PlanItem['kind'];
    ref_id?: number | null;
    time?: string | null;
  }[],
) {
  const date = await nextWorkDay(employeeId);
  const clean: PlanItem[] = items.map((i) => ({
    id: i.id || randomUUID(),
    text: i.text.trim().slice(0, 300),
    kind: i.kind || 'NOTE',
    ref_id: i.ref_id ?? null,
    time: i.time ?? null,
    done: false,
  }));
  await p.dayPlan.upsert({
    where: { employee_id_plan_date: { employee_id: employeeId, plan_date: date } },
    create: { employee_id: employeeId, plan_date: date, items: clean as any },
    update: { items: clean as any },
  });
  return { date, items: clean, saved: true };
}

export async function setItemDone(employeeId: number, itemId: string, done: boolean) {
  const date = getISTComponents(new Date()).dateString;
  const plan = await getPlan(employeeId, date);
  const items = plan.items.map((i) => (i.id === itemId ? { ...i, done } : i));
  await p.dayPlan.update({
    where: { employee_id_plan_date: { employee_id: employeeId, plan_date: date } },
    data: { items: items as any },
  });
  return { date, items, saved: true };
}

/** Today's assigned calls, for the telecaller's own screen. */
export async function callCounts(employeeId: number) {
  const start = dayRange(getISTComponents(new Date()).dateString).gte;
  const [left, overdue, assignedToday] = await Promise.all([
    p.lead.count({ where: uncalledAssigned(employeeId) }),
    p.lead.count({ where: { ...uncalledAssigned(employeeId), assigned_at: { lt: start } } }),
    p.lead.count({
      where: {
        assigned_to_id: employeeId,
        assignment_type: DAILY_ASSIGNMENT,
        assigned_at: { gte: start },
      },
    }),
  ]);
  return { left, overdue, assigned_today: assignedToday };
}

/**
 * What still stands between this person and logging out: assigned calls not made,
 * and no plan for their next working day. The same check runs for the app's logout
 * button and for QR / work-from-home checkout. Not applied to people who don't
 * follow attendance, on a day they haven't checked in, or after an approved
 * emergency request.
 */
export async function getLogoutBlockers(employee: { id: number; attendance_required: boolean }) {
  const none = {
    blocked: false,
    calls_left: 0,
    plan_missing: false,
    plan_date: null,
    message: null,
  };
  if (!employee.attendance_required) return none;

  const today = getISTComponents(new Date()).dateString;
  const range = dayRange(today);
  const [checkedIn, emergency] = await Promise.all([
    p.attendanceLog.findFirst({
      where: { employee_id: employee.id, check_out_at: null, check_in_at: range },
      select: { id: true },
    }),
    p.attendanceProposal.findFirst({
      where: {
        employee_id: employee.id,
        type: 'EARLY_CHECKOUT',
        status: 'APPROVED',
        target_date: { gte: range.gte, lt: range.lt },
      },
      select: { id: true },
    }),
  ]);
  if (!checkedIn || emergency) return none;

  const date = await nextWorkDay(employee.id);
  const [callsLeft, plan] = await Promise.all([
    p.lead.count({ where: uncalledAssigned(employee.id) }),
    p.dayPlan.findUnique({
      where: { employee_id_plan_date: { employee_id: employee.id, plan_date: date } },
      select: { id: true },
    }),
  ]);
  const planMissing = !plan;
  const message =
    callsLeft > 0
      ? `Finish your ${callsLeft} assigned call${callsLeft === 1 ? '' : 's'} first: log a call on each in the CRM app, then scan again.`
      : planMissing
        ? "Save tomorrow's plan first (CRM app → My Day), then scan again."
        : null;
  return {
    blocked: callsLeft > 0 || planMissing,
    calls_left: callsLeft,
    plan_missing: planMissing,
    plan_date: date,
    message,
  };
}

// ---- What the team plans for their next working day (MD, Admin, HR) ----

/** Where a person is on the day their plan is for. */
export interface Presence {
  kind: 'LEAVE' | 'LEAVE_PENDING' | 'WFH' | 'FIELD' | 'OFF' | 'PRESENT' | 'ABSENT' | 'NOT_IN_YET';
  label: string;
}

export interface TeamPlanPerson {
  id: number;
  name: string;
  employee_code: string;
  roles: string[];
  /** Their next working day: tomorrow, or later when tomorrow is a day off for them. */
  plan_date: string;
  /** True when plan_date is a later day because tomorrow is their day off. */
  later_than_tomorrow: boolean;
  required: boolean;
  /** Today's view only: today is a day off for them. */
  day_off: boolean;
  status: 'PLANNED' | 'MISSING';
  /** On approved leave or a day off: not expected to have written a plan. */
  excused: boolean;
  /** On leave, working from home, absent, a day off, present... or null when nothing to say. */
  presence: Presence | null;
  items: PlanItem[];
  saved_at: string | null;
}

/**
 * Everyone in `scope` who is active, with the plan for `day`: their next working day
 * (default), or today (the plan they wrote yesterday, with what they have ticked off).
 * A person whose tomorrow is a day off is looked up for the next day they work, the same
 * rule their own logout check uses. People who must plan (attendance required) and have
 * not are marked MISSING; others only appear when they did write one.
 */
export async function listTeamPlans(
  scope: Prisma.EmployeeWhereInput,
  day: 'today' | 'tomorrow' = 'tomorrow',
) {
  const today = getISTComponents(new Date()).dateString;
  const tomorrow = addDays(today, 1);
  const people = await p.employee.findMany({
    where: { ...scope, status: 'ACTIVE' },
    select: {
      id: true,
      full_name: true,
      employee_code: true,
      company_id: true,
      weekly_off_day: true,
      attendance_required: true,
      roles: { select: { role: { select: { name: true } } } },
    },
    orderBy: { full_name: 'asc' },
  });

  // The day each person's plan is for. Today: today. Tomorrow: their next working day,
  // looking up to a week ahead, one batch per day.
  const next = new Map<number, string>();
  const offToday = new Set<number>();
  const offLabel = new Map<number, string>();
  if (day === 'today') {
    const info = await dayInfoMany(people, today);
    for (const e of people) {
      next.set(e.id, today);
      if (info.get(e.id)?.offDay) {
        offToday.add(e.id);
        offLabel.set(e.id, info.get(e.id)?.label || 'Day off');
      }
    }
  } else {
    for (let n = 1; n <= 7 && next.size < people.length; n++) {
      const date = addDays(today, n);
      const open = people.filter((e) => !next.has(e.id));
      // eslint-disable-next-line no-await-in-loop
      const info = await dayInfoMany(open, date);
      for (const e of open) if (!info.get(e.id)?.offDay) next.set(e.id, date);
    }
  }

  const dates = [...new Set([...next.values(), day === 'today' ? today : tomorrow])];
  const plans = await p.dayPlan.findMany({
    where: { employee_id: { in: people.map((e) => e.id) }, plan_date: { in: dates } },
    select: { employee_id: true, plan_date: true, items: true, updated_at: true },
  });
  const planOf = new Map(plans.map((pl) => [`${pl.employee_id}|${pl.plan_date}`, pl]));

  // Leave, work from home and field work approved or asked for on those days, and
  // (for today) who has checked in.
  const dayStart = (d: string) => new Date(`${d}T00:00:00+05:30`);
  const firstDate = [...dates].sort()[0];
  const lastDate = [...dates].sort().slice(-1)[0];
  const ids = people.map((e) => e.id);
  const [requests, checkIns] = await Promise.all([
    p.attendanceProposal.findMany({
      where: {
        employee_id: { in: ids },
        type: { in: ['LEAVE', 'WORK_FROM_HOME', 'FIELD_WORK'] },
        status: { in: ['APPROVED', 'PENDING'] },
        target_date: { gte: dayStart(firstDate), lt: dayStart(addDays(lastDate, 1)) },
      },
      select: { employee_id: true, type: true, status: true, leave_type: true, target_date: true },
    }),
    day === 'today'
      ? p.attendanceLog.findMany({
          where: {
            employee_id: { in: ids },
            check_in_at: { gte: dayStart(today), lt: dayStart(addDays(today, 1)) },
          },
          select: { employee_id: true, source: true },
        })
      : Promise.resolve([] as { employee_id: number; source: string }[]),
  ]);
  const checkInOf = new Map(checkIns.map((c) => [c.employee_id, c.source]));
  const istHour = Number(getISTComponents(new Date()).timeString.slice(0, 2));
  const presenceFor = (employeeId: number, date: string): Presence | null => {
    const mine = requests.filter(
      (r) => r.employee_id === employeeId && getISTComponents(r.target_date).dateString === date,
    );
    const leave = mine.find((r) => r.type === 'LEAVE' && r.status === 'APPROVED');
    if (leave) {
      return {
        kind: 'LEAVE',
        label:
          leave.leave_type === 'FIRST_HALF'
            ? 'On leave, first half'
            : leave.leave_type === 'SECOND_HALF'
              ? 'On leave, second half'
              : 'On leave',
      };
    }
    const wfh = mine.find((r) => r.type === 'WORK_FROM_HOME' && r.status === 'APPROVED');
    if (wfh || checkInOf.get(employeeId) === 'REMOTE') {
      return { kind: 'WFH', label: 'Working from home' };
    }
    if (mine.some((r) => r.type === 'FIELD_WORK' && r.status === 'APPROVED')) {
      return { kind: 'FIELD', label: 'Field work' };
    }
    if (day === 'today') {
      if (offToday.has(employeeId)) {
        return { kind: 'OFF', label: offLabel.get(employeeId) || 'Day off' };
      }
      if (checkInOf.has(employeeId)) return { kind: 'PRESENT', label: 'Checked in' };
      if (mine.some((r) => r.type === 'LEAVE' && r.status === 'PENDING')) {
        return { kind: 'LEAVE_PENDING', label: 'Leave asked, not approved yet' };
      }
      return istHour >= 11
        ? { kind: 'ABSENT', label: 'Absent: not checked in' }
        : { kind: 'NOT_IN_YET', label: 'Not checked in yet' };
    }
    if (mine.some((r) => r.type === 'LEAVE' && r.status === 'PENDING')) {
      return { kind: 'LEAVE_PENDING', label: 'Leave asked, not approved yet' };
    }
    return null;
  };

  const out: TeamPlanPerson[] = [];
  for (const e of people) {
    const date = next.get(e.id) || tomorrow;
    const plan = planOf.get(`${e.id}|${date}`);
    if (!plan && !e.attendance_required) continue;
    // Not expected at work today and nothing written: nothing to show.
    if (!plan && offToday.has(e.id)) continue;
    const presence = presenceFor(e.id, date);
    out.push({
      id: e.id,
      name: e.full_name || e.employee_code,
      employee_code: e.employee_code,
      roles: e.roles.map((r) => r.role.name),
      plan_date: date,
      later_than_tomorrow: day === 'tomorrow' && date !== tomorrow,
      required: e.attendance_required,
      day_off: offToday.has(e.id),
      status: plan ? 'PLANNED' : 'MISSING',
      excused: presence?.kind === 'LEAVE' || presence?.kind === 'OFF',
      presence,
      items: ((plan?.items as unknown as PlanItem[]) || []).map((i) => ({
        id: i.id,
        text: i.text,
        kind: i.kind,
        ref_id: i.ref_id ?? null,
        time: i.time ?? null,
        done: !!i.done,
      })),
      saved_at: plan ? plan.updated_at.toISOString() : null,
    });
  }
  // Planned first, then people who did not plan, then those on leave or off who did not
  // need to; each group stays in name order (the sort is stable).
  const rank = (x: TeamPlanPerson) => (x.status === 'PLANNED' ? 0 : x.excused ? 2 : 1);
  out.sort((a, b) => rank(a) - rank(b));
  return {
    day,
    today,
    tomorrow,
    planned: out.filter((x) => x.status === 'PLANNED').length,
    missing: out.filter((x) => x.status === 'MISSING' && !x.excused).length,
    away: out.filter((x) => x.excused && x.status === 'MISSING').length,
    people: out,
  };
}

/** The next working day's plans (kept for callers that predate the Today view). */
export const listTeamTomorrow = (scope: Prisma.EmployeeWhereInput) =>
  listTeamPlans(scope, 'tomorrow');
