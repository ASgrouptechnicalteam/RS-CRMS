import { prisma } from '../lib/prisma';
import { TokenPayload } from '../utils/jwt';
import { getISTComponents } from '../utils/time';
import { Roles, SOP_BY_ROLE, SOP_ROLE_ORDER, SopAuto, SopItem } from '../shared';
import { nextWorkDay } from './dayPlan.service';
import { uncalledAssigned } from './lead/masterLeads';
import { followUpsDue } from './counts/followUps';
import { CALL_BACK_TITLE_PREFIX } from './lead/callBacks';
import { AppError } from './lead/errors';

const p = prisma;

const CLOSED_TASK = ['COMPLETED', 'CANCELLED', 'NOT_COMPLETED', 'BLOCKED'];

/** The roles whose SOPs apply: a Technical Manager's Admin alias is not a second role. */
export function sopRoles(roles: string[]): string[] {
  const own = roles.includes(Roles.TECHNICAL_MANAGER)
    ? roles.filter((r) => r !== Roles.ADMIN)
    : roles;
  return SOP_ROLE_ORDER.filter((r) => own.includes(r));
}

/** Items for these roles, each key once, filtered to what the person is held to. */
export function itemsFor(
  roles: string[],
  flags: { attendance_required: boolean; report_required: boolean },
): SopItem[] {
  const seen = new Set<string>();
  const out: SopItem[] = [];
  for (const role of sopRoles(roles)) {
    for (const it of SOP_BY_ROLE[role]?.items || []) {
      if (seen.has(it.key)) continue;
      if (it.needs === 'ATTENDANCE' && !flags.attendance_required) continue;
      if (it.needs === 'REPORT' && !flags.report_required) continue;
      seen.add(it.key);
      out.push(it);
    }
  }
  return out;
}

const dayRange = (date: string) => {
  const gte = new Date(`${date}T00:00:00+05:30`);
  return { gte, lt: new Date(gte.getTime() + 86400000) };
};

type Ctx = {
  user: TokenPayload;
  now: Date;
  date: string;
  range: { gte: Date; lt: Date };
};
/** Each returns { done, detail } from real data. */
type Check = (c: Ctx) => Promise<{ done: boolean; detail?: string }>;
const left = (n: number, what: string) => ({
  done: n === 0,
  detail: n === 0 ? undefined : `${n} ${what}`,
});

const company = (c: Ctx) => c.user.companyId;

const CHECKS: Record<SopAuto, Check> = {
  CHECKED_IN: async (c) => ({
    done: !!(await p.attendanceLog.findFirst({
      where: { employee_id: c.user.employeeId, check_in_at: c.range },
      select: { id: true },
    })),
  }),
  CHECKED_OUT: async (c) => ({
    done: !!(await p.attendanceLog.findFirst({
      where: {
        employee_id: c.user.employeeId,
        check_in_at: c.range,
        check_out_at: { not: null },
      },
      select: { id: true },
    })),
  }),
  CALLS_DONE: async (c) =>
    left(await p.lead.count({ where: uncalledAssigned(c.user.employeeId) }), 'to call'),
  FOLLOW_UPS_CLEARED: async (c) => {
    const due = (await followUpsDue([c.user.employeeId], company(c), c.now)).get(c.user.employeeId);
    return left(due?.total || 0, 'due');
  },
  TASKS_DONE: async (c) =>
    left(
      await p.task.count({
        where: {
          assignee_id: c.user.employeeId,
          status: { notIn: CLOSED_TASK },
          target_date: { lt: c.range.lt },
          NOT: { title: { startsWith: CALL_BACK_TITLE_PREFIX } },
        },
      }),
      'open',
    ),
  PLAN_WRITTEN: async (c) => ({
    done: !!(await p.dayPlan.findUnique({
      where: {
        employee_id_plan_date: {
          employee_id: c.user.employeeId,
          plan_date: await nextWorkDay(c.user.employeeId),
        },
      },
      select: { id: true },
    })),
  }),
  REPORT_SENT: async (c) => ({
    done: !!(await p.dailyReport.findFirst({
      where: { employee_id: c.user.employeeId, submitted_at: c.range },
      select: { id: true },
    })),
  }),
  VISITS_UPDATED: async (c) => {
    const me = c.user.employeeId;
    return left(
      await p.siteVisitBooking.count({
        where: {
          scheduled_date: { gte: c.range.gte, lt: c.now },
          status: { in: ['ACCEPTED', 'CONFIRMED', 'ACTIVE', 'ON_HOLD'] },
          OR: [{ project_manager_id: me }, { assigned_agent_id: me }],
        },
      }),
      'to update',
    );
  },
  PM_VISITS_ACCEPTED: async (c) =>
    left(
      await p.siteVisitBooking.count({
        where: {
          project_manager_id: c.user.employeeId,
          status: { in: ['REQUESTED', 'PENDING_ACCEPTANCE'] },
        },
      }),
      'waiting',
    ),
  PM_VERIFIED: async (c) =>
    left(
      await p.property.count({
        where: { assigned_pm_id: c.user.employeeId, status: 'PENDING_VERIFICATION' },
      }),
      'waiting',
    ),
  DM_POLISHED: async (c) => {
    const [props, projects] = await Promise.all([
      p.property.count({ where: { company_id: company(c), status: 'PENDING_DM_POLISH' } }),
      p.project.count({
        where: { company_id: company(c), verification_status: 'PENDING_DM_POLISH' },
      }),
    ]);
    return left(props + projects, 'waiting');
  },
  HR_QUEUE_CLEARED: async (c) => {
    const ids = (
      await p.employee.findMany({ where: { company_id: company(c) }, select: { id: true } })
    ).map((e) => e.id);
    const [requests, photos] = await Promise.all([
      p.attendanceProposal.count({ where: { status: 'PENDING', employee_id: { in: ids } } }),
      p.attendanceCheckinProof.count({
        where: { review_status: 'PENDING', employee_id: { in: ids } },
      }),
    ]);
    return left(requests + photos, 'waiting');
  },
  FINANCE_QUEUE_CLEARED: async (c) =>
    left(
      await p.payment.count({
        where: { company_id: company(c), status: { in: ['PENDING', 'REFUND_DUE'] } },
      }),
      'waiting',
    ),
  APPROVALS_CLEARED: async (c) => {
    const co = { company_id: company(c) };
    const ids = (await p.employee.findMany({ where: co, select: { id: true } })).map((e) => e.id);
    const counts = await Promise.all([
      p.property.count({ where: { ...co, status: 'PENDING_MD_APPROVAL' } }),
      p.project.count({ where: { ...co, verification_status: 'PENDING_MD_APPROVAL' } }),
      p.booking.count({ where: { ...co, form_status: 'SUBMITTED' } }),
      p.expenseRefund.count({ where: { ...co, status: 'ACCOUNTANT_APPROVED' } }),
      p.attendanceProposal.count({ where: { status: 'PENDING', employee_id: { in: ids } } }),
    ]);
    return left(
      counts.reduce((a, b) => a + b, 0),
      'waiting',
    );
  },
};

export interface ChecklistItem {
  key: string;
  block: SopItem['block'];
  text: string;
  link?: string;
  /** Worked out from real data: cannot be ticked or unticked by hand. */
  manual: boolean;
  done: boolean;
  detail?: string;
}

const flagsOf = async (employeeId: number) => {
  const e = await p.employee.findUnique({
    where: { id: employeeId },
    select: { attendance_required: true, report_required: true },
  });
  return {
    attendance_required: e?.attendance_required !== false,
    report_required: e?.report_required !== false,
  };
};

/** The signed-in person's checklist for today (IST). `now` is for tests. */
export async function getChecklist(user: TokenPayload, now: Date = new Date()) {
  const date = getISTComponents(now).dateString;
  const items = itemsFor(user.roles, await flagsOf(user.employeeId));
  const ctx: Ctx = { user, now, date, range: dayRange(date) };

  const kinds = [...new Set(items.map((i) => i.auto).filter((a): a is SopAuto => !!a))];
  const [ticks, ...results] = await Promise.all([
    p.sopChecklistTick.findMany({
      where: { employee_id: user.employeeId, tick_date: date },
      select: { item_key: true },
    }),
    ...kinds.map((k) => CHECKS[k](ctx)),
  ]);
  const ticked = new Set(ticks.map((t) => t.item_key));
  const byKind = new Map(kinds.map((k, i) => [k, results[i]]));

  const list: ChecklistItem[] = items.map((i) => {
    const auto = i.auto ? byKind.get(i.auto) : undefined;
    return {
      key: i.key,
      block: i.block,
      text: i.text,
      link: i.link,
      manual: !i.auto,
      done: i.auto ? !!auto?.done : ticked.has(i.key),
      detail: auto && !auto.done ? auto.detail : undefined,
    };
  });
  return {
    date,
    roles: sopRoles(user.roles),
    items: list,
    done: list.filter((i) => i.done).length,
    total: list.length,
  };
}

/** Tick or untick a manual item of the signed-in person, for today (IST). */
export async function setTick(
  user: TokenPayload,
  key: string,
  done: boolean,
  now: Date = new Date(),
) {
  const date = getISTComponents(now).dateString;
  const item = itemsFor(user.roles, await flagsOf(user.employeeId)).find((i) => i.key === key);
  if (!item) throw new AppError(404, 'That item is not on your checklist');
  if (item.auto) throw new AppError(400, 'This item ticks itself from the CRM record');
  const where = { employee_id: user.employeeId, tick_date: date, item_key: key };
  if (done) {
    await p.sopChecklistTick.upsert({
      where: { employee_id_tick_date_item_key: where },
      create: where,
      update: {},
    });
  } else {
    await p.sopChecklistTick.deleteMany({ where });
  }
  return { key, done };
}
