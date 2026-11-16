import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { TokenPayload } from '../utils/jwt';
import { Roles, Permissions } from '../shared';
import { notifyEmployee } from '../utils/notifyEmployee';
import { logger } from '../utils/logger';
import { toHolidayDateKey, todayKeyIST } from '../utils/time';
import { moveLeadsKeepingStage, LEAD_CHUNK } from './lead/handoverMove';
import {
  activeContactedLeads,
  untouchedLeads,
  ACTIVE_LEAD_STATUSES,
} from './lead/masterLeadReturn';

const p = prisma;

const OPEN_TASK_STATUSES = ['PENDING', 'IN_PROGRESS', 'OVERDUE', 'BLOCKED'];
const CLOSED_VISIT_STATUSES = ['COMPLETED', 'CANCELLED'] as any;

export class OffboardError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * "2026-11-15" (or an ISO string starting with it) -> that calendar day as
 * UTC midnight, the same way other date-only fields are stored. Comparing
 * against today's IST date key then gives "the last working day is over".
 */
export function toDayKey(value: string): Date {
  const day = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new OffboardError(400, 'Invalid date');
  return toHolidayDateKey(day);
}

/** Someone who can take over a leaver's leads: active, same company, can work leads. */
export async function findHandoverTarget(companyId: number, targetId: number, leaverId: number) {
  if (targetId === leaverId) return null;
  return p.employee.findFirst({
    where: {
      id: targetId,
      company_id: companyId,
      status: 'ACTIVE',
      deleted_at: null,
      roles: {
        some: {
          role: { permissions: { some: { permission: { name: Permissions.LEADS_UPDATE } } } },
        },
      },
    },
    select: { id: true, full_name: true, employee_code: true, company_id: true },
  });
}

/**
 * Everything a person still owns. `moves` is what a handover moves to one
 * person; `manual` needs someone with the right role (a PM, an agent...), so
 * HR picks those on the existing pages.
 */
export async function getHandoverSummary(employeeId: number) {
  const now = new Date();
  const emp = await p.employee.findUnique({
    where: { id: employeeId },
    select: { company_id: true, reporting_manager_id: true },
  });
  if (!emp) throw new OffboardError(404, 'Employee not found');
  const [
    leads,
    tasks,
    customers,
    pmVisits,
    agentVisits,
    projects,
    properties,
    complaints,
    demos,
    bookings,
    directReports,
    targets,
    contactedByStage,
    notContacted,
    dropped,
    closed,
  ] = await Promise.all([
    p.lead.count({
      where: { assigned_to_id: employeeId, status: { in: ACTIVE_LEAD_STATUSES } },
    }),
    p.task.count({ where: { assignee_id: employeeId, status: { in: OPEN_TASK_STATUSES } } }),
    p.customer.count({ where: { assigned_to_id: employeeId } }),
    p.siteVisitBooking.count({
      where: { project_manager_id: employeeId, status: { notIn: CLOSED_VISIT_STATUSES } },
    }),
    p.siteVisitBooking.count({
      where: { assigned_agent_id: employeeId, status: { notIn: CLOSED_VISIT_STATUSES } },
    }),
    p.project.count({
      where: { assigned_pm_id: employeeId, status: { notIn: ['COMPLETED', 'CANCELLED'] } },
    }),
    p.property.count({
      where: { assigned_pm_id: employeeId, status: { notIn: ['SOLD', 'REJECTED'] } },
    }),
    p.complaint.count({
      where: { assigned_employee_id: employeeId, status: { notIn: ['RESOLVED', 'CLOSED'] } },
    }),
    p.demo.count({
      where: { handler_id: employeeId, status: { notIn: ['COMPLETED', 'CANCELLED'] } },
    }),
    p.booking.count({
      where: {
        assigned_employee_id: employeeId,
        status: { notIn: ['COMPLETED', 'CANCELLED', 'REGISTERED'] },
      },
    }),
    p.employee.count({
      where: { reporting_manager_id: employeeId, status: 'ACTIVE', deleted_at: null },
    }),
    // Who can take the work: same rule as findHandoverTarget.
    p.employee.findMany({
      where: {
        company_id: emp.company_id,
        status: 'ACTIVE',
        deleted_at: null,
        id: { not: employeeId },
        roles: {
          some: {
            role: { permissions: { some: { permission: { name: Permissions.LEADS_UPDATE } } } },
          },
        },
      },
      select: { id: true, full_name: true, employee_code: true },
      orderBy: { full_name: 'asc' },
    }),
    p.lead.groupBy({
      by: ['status'],
      where: activeContactedLeads(employeeId),
      _count: { _all: true },
    }),
    p.lead.count({ where: untouchedLeads(employeeId) }),
    p.lead.count({ where: { assigned_to_id: employeeId, status: 'DROPPED' } }),
    p.lead.count({
      where: { assigned_to_id: employeeId, status: { in: ['BOOKED', 'RECOVERED_TO_POOL'] } },
    }),
  ]);
  const by_stage: Record<string, number> = {};
  for (const g of contactedByStage) by_stage[g.status] = g._count._all;
  const contactedActive = contactedByStage.reduce((n, g) => n + g._count._all, 0);
  return {
    as_of: now,
    moves: { leads, tasks, customers },
    /** Contacted and active: what a hand-over moves to people. */
    contacted_active: contactedActive,
    contacted: contactedActive,
    by_stage,
    /** Untouched: they go back to master data. */
    not_contacted: notContacted,
    /** Stay with the leaver, never handed over. */
    dropped,
    closed,
    manual: {
      pm_visits: pmVisits,
      agent_visits: agentVisits,
      projects,
      properties,
      complaints,
      demos,
      bookings,
      direct_reports: directReports,
    },
    targets: targets.map((t) => ({
      id: t.id,
      name: t.full_name || t.employee_code,
      code: t.employee_code,
    })),
    suggested_target_id: targets.some((t) => t.id === emp.reporting_manager_id)
      ? emp.reporting_manager_id
      : null,
  };
}

/**
 * Move a leaver's open work to one colleague: open leads (with their call-backs,
 * opportunities and upcoming telecaller visits), any other open tasks, and
 * their customers. Leads in a company the target is not in stay put and are
 * counted in `leads_left`. One summary notification to the new owner.
 */
export async function handOverWork(
  leaverId: number,
  targetId: number,
  actor: TokenPayload,
  reason: string,
  options: { onlyContacted?: boolean } = {},
) {
  const leaver = await p.employee.findUnique({
    where: { id: leaverId },
    select: { id: true, full_name: true, employee_code: true, company_id: true },
  });
  if (!leaver) throw new OffboardError(404, 'Employee not found');
  const target = await findHandoverTarget(leaver.company_id, targetId, leaverId);
  if (!target) {
    throw new OffboardError(
      400,
      'That colleague cannot take the work (not active, another company, or their role cannot work leads).',
    );
  }
  const leaverName = leaver.full_name || leaver.employee_code;
  const targetName = target.full_name || target.employee_code;
  const note = `Handed over from ${leaverName} to ${targetName} (${reason}).`;

  const moved = { leads: 0, call_backs: 0, opportunities: 0, visits: 0, tasks: 0, customers: 0 };
  let leadsLeft = 0;
  let failed = 0;
  let leadsNotContacted = 0;
  const where: Prisma.LeadWhereInput = options.onlyContacted
    ? activeContactedLeads(leaverId)
    : { assigned_to_id: leaverId, status: { in: ACTIVE_LEAD_STATUSES } };
  // Untouched leads wait for the return to master data; a person should not get them.
  if (options.onlyContacted) {
    leadsNotContacted = await p.lead.count({ where: untouchedLeads(leaverId) });
  }

  // Chunks by id so a lead that fails to move (e.g. a workflow guard) is
  // skipped and counted, never retried forever.
  let afterId = 0;
  for (;;) {
    const chunk = await p.lead.findMany({
      where: { ...where, id: { gt: afterId } },
      orderBy: { id: 'asc' },
      take: LEAD_CHUNK,
    });
    if (chunk.length === 0) break;
    afterId = chunk[chunk.length - 1].id;
    const t = await moveLeadsKeepingStage(
      chunk,
      target,
      actor,
      { action: 'LEAD_HANDED_OVER', note, reason },
      leaverId,
    );
    moved.leads += t.leads;
    moved.call_backs += t.call_backs;
    moved.opportunities += t.opportunities;
    moved.visits += t.visits;
    leadsLeft += t.left;
    failed += t.failed;
  }

  await p.$transaction(async (tx) => {
    moved.tasks = (
      await tx.task.updateMany({
        where: { assignee_id: leaverId, status: { in: OPEN_TASK_STATUSES } },
        data: { assignee_id: target.id },
      })
    ).count;
    moved.customers = (
      await tx.customer.updateMany({
        where: { assigned_to_id: leaverId, company_id: target.company_id },
        data: { assigned_to_id: target.id },
      })
    ).count;
    await tx.auditEvent.create({
      data: {
        actor_id: actor.employeeId,
        action: 'EMPLOYEE_HANDOVER',
        entity_type: 'EMPLOYEE',
        entity_id: leaverId,
        new_value: JSON.stringify({
          to_employee_id: target.id,
          reason,
          moved,
          leads_left: leadsLeft,
          leads_failed: failed,
          leads_not_contacted: leadsNotContacted,
        }),
      },
    });
  });

  const parts = [
    `${moved.leads} lead${moved.leads === 1 ? '' : 's'}`,
    moved.call_backs ? `${moved.call_backs} call-back${moved.call_backs === 1 ? '' : 's'}` : '',
    moved.tasks ? `${moved.tasks} other task${moved.tasks === 1 ? '' : 's'}` : '',
    moved.customers ? `${moved.customers} customer${moved.customers === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  if (moved.leads + moved.tasks + moved.customers > 0) {
    await notifyEmployee(target.id, {
      type: 'TARGET_ASSIGNED',
      title: `${leaverName}'s work is now yours`,
      message: `${parts.join(', ')} handed over to you from ${leaverName}.`,
      link: '/leads',
    }).catch((e) => logger.error('[handover] notify failed:', e));
  }

  return {
    to: target,
    moved,
    leads_left: leadsLeft,
    leads_failed: failed,
    leads_not_contacted: leadsNotContacted,
  };
}

async function notifyManagement(companyId: number, title: string, message: string, link: string) {
  const people = await p.employee.findMany({
    where: {
      company_id: companyId,
      status: 'ACTIVE',
      roles: { some: { role: { name: { in: [Roles.MD, Roles.HR_MANAGER] } } } },
    },
    select: { id: true },
  });
  if (people.length === 0) return;
  await notifyEmployee(
    people.map((x) => x.id),
    { type: 'STATUS_CHANGED', title, message, link },
  ).catch((e) => logger.error('[offboard] notify failed:', e));
}

/**
 * The last-day step: lock the person out and hand over their work to
 * `handover_to_id`. Safe to call twice (does nothing once `offboarded_at` is
 * set). If the chosen colleague can no longer take the work, or none was
 * chosen and work is left, HR/MD are told to pick someone; the lock-out
 * happens either way.
 */
export async function offboardEmployee(employeeId: number, actor: TokenPayload) {
  const emp = await p.employee.findUnique({ where: { id: employeeId } });
  if (!emp || emp.offboarded_at) return null;

  await p.$transaction(async (tx) => {
    await tx.employee.update({
      where: { id: employeeId },
      data: {
        status: 'RESIGNED',
        offboarded_at: new Date(),
        token_version: { increment: 1 },
      },
    });
    await tx.authSession.updateMany({
      where: { employee_id: employeeId, revoked: false },
      data: { revoked: true, revocation_reason: 'AUTHORIZATION_CHANGED' },
    });
    await tx.auditEvent.create({
      data: {
        actor_id: actor.employeeId,
        action: 'EMPLOYEE_RESIGNED',
        entity_type: 'EMPLOYEE',
        entity_id: employeeId,
        old_value: JSON.stringify({ status: emp.status }),
        new_value: JSON.stringify({
          status: 'RESIGNED',
          resignation_date: emp.resignation_date,
          last_working_day: emp.last_working_day,
          handover_to_id: emp.handover_to_id,
        }),
      },
    });
  });

  const name = emp.full_name || emp.employee_code;
  const link = '/employees';
  let handover: Awaited<ReturnType<typeof handOverWork>> | null = null;
  if (emp.handover_to_id) {
    try {
      handover = await handOverWork(employeeId, emp.handover_to_id, actor, 'resigned', {
        onlyContacted: true,
      });
    } catch (e) {
      if (!(e instanceof OffboardError)) logger.error('[offboard] handover failed:', e);
    }
  }

  if (!handover) {
    const left = await getHandoverSummary(employeeId);
    const open = left.moves.leads + left.moves.tasks + left.moves.customers;
    if (open > 0) {
      await notifyManagement(
        emp.company_id,
        `${name} has left — their work needs a new owner`,
        emp.handover_to_id
          ? `The colleague chosen to take over can no longer take it. ${left.moves.leads} open leads and ${left.moves.tasks} tasks are still with ${name}. Hand them over from their profile.`
          : `${left.moves.leads} open leads and ${left.moves.tasks} tasks are still with ${name}. Hand them over from their profile.`,
        link,
      );
    }
  } else if (handover.leads_left + handover.leads_failed > 0) {
    await notifyManagement(
      emp.company_id,
      `Some of ${name}'s leads were not handed over`,
      `${handover.leads_left + handover.leads_failed} leads are still with ${name}. Hand them over from their profile.`,
      link,
    );
  }
  if (handover && handover.leads_not_contacted > 0) {
    await notifyManagement(
      emp.company_id,
      `${name}'s uncontacted leads are waiting`,
      `${handover.leads_not_contacted} leads nobody has contacted are still with ${name}. Return them from Master Data.`,
      '/master-data',
    );
  }

  return { handover };
}

/** The person who recorded the resignation acts for the nightly job (audit + lead notes). */
async function actorForJob(emp: { id: number; company_id: number }): Promise<TokenPayload> {
  const recorded = await p.auditEvent.findFirst({
    where: { entity_type: 'EMPLOYEE', entity_id: emp.id, action: 'EMPLOYEE_RESIGNATION_RECORDED' },
    orderBy: { created_at: 'desc' },
    select: { actor_id: true },
  });
  return {
    employeeId: recorded?.actor_id ?? emp.id,
    employeeCode: 'SYSTEM',
    companyId: emp.company_id,
    branchId: null,
    roles: [Roles.HR_MANAGER],
    permissions: [],
  };
}

/** Nightly + on-start catch-up: offboard everyone whose last working day is over. */
export async function offboardDueLeavers() {
  const due = await p.employee.findMany({
    where: {
      status: 'ACTIVE',
      resignation_date: { not: null },
      last_working_day: { lt: todayKeyIST() },
      offboarded_at: null,
    },
    select: { id: true, company_id: true },
  });
  let done = 0;
  for (const emp of due) {
    try {
      await offboardEmployee(emp.id, await actorForJob(emp));
      done++;
    } catch (e) {
      logger.error(`[offboard] employee ${emp.id} failed:`, e);
    }
  }
  if (due.length) logger.info(`[offboard] ${done}/${due.length} leaver(s) offboarded.`);
  return done;
}
