import { randomUUID } from 'crypto';
import { prisma } from '../lib/prisma';
import { getISTComponents } from '../utils/time';
import { dayInfo } from './workCalendar';
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
