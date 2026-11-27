import { prisma } from '../../lib/prisma';
import { TokenPayload } from '../../utils/jwt';
import { Roles, Permissions } from '../../shared';
import { can } from '../../authz/authorization';
import { WorkflowEngine } from '../../workflows/workflowEngine';
import { WorkflowDomain } from '../../workflows/types';
import { SiteVisitPolicy } from '../../policies/siteVisit.policy';
import {
  applyTransition,
  assertNoOtherVisitThen,
  dropReasonFromOutcomes,
  findVisitForUser,
} from './shared';
import { OFFICE_CHANGE, offerToPartner, partnerOfVisit } from './assignee';
import { createFeedbackRequest, dispatchFeedbackRequestNotification } from '../feedback.service';
import { notifyEmployee } from '../../utils/notifyEmployee';
import { logger } from '../../utils/logger';
import { getISTComponents } from '../../utils/time';
import { markPresentFromVisit } from '../visitAttendance';
const p = prisma;

/** accept: PM/Agent accepts the routed visit. */
export async function acceptVisit(user: TokenPayload, visitId: number, notes?: string) {
  const visit = await findVisitForUser(user, visitId);
  if (!can(user, Permissions.SITE_VISITS_ACCEPT, visit)) {
    throw { status: 403, message: 'Forbidden: Missing permission to accept site visits' };
  }
  if (!SiteVisitPolicy.canAccept(user, visit)) {
    throw { status: 403, message: 'Forbidden: only the routed PM/Agent may accept this visit' };
  }

  if (await partnerOfVisit(visit)) {
    throw {
      status: 409,
      message:
        'This visit is waiting for the channel partner. Use "Pass on" to give it to a project manager instead.',
    };
  }

  const me = await p.employee.findUnique({
    where: { id: user.employeeId },
    select: { full_name: true, employee_code: true },
  });
  const who = me?.full_name || me?.employee_code || user.employeeCode;

  return applyTransition(
    user,
    visitId,
    'ACCEPT',
    { project_manager_id: user.employeeId },
    'SITE_VISIT_ACCEPTED',
    `Site visit ${visit.booking_code} accepted by ${who}.${notes ? ` Notes: ${notes}` : ''}`,
  );
}

/** reassign: open chain during initial acceptance — logged to SiteVisitReassignment, resets to PENDING_ACCEPTANCE. */
export async function reassignVisit(
  user: TokenPayload,
  visitId: number,
  toEmployeeId: number,
  reason: string,
) {
  const visit = await findVisitForUser(user, visitId);
  if (!SiteVisitPolicy.canRouteVisit(user, visit)) {
    throw {
      status: 403,
      message: 'Forbidden: only the project manager this visit is routed to can pass it on',
    };
  }

  const targetWithRoles = await p.employee.findFirst({
    where: { id: toEmployeeId },
    include: { roles: { include: { role: true } } },
  });
  if (!targetWithRoles) throw { status: 404, message: 'Target employee not found' };
  const target = {
    ...targetWithRoles,
    roles: (targetWithRoles.roles || []).map((er: any) => er.role?.name).filter(Boolean),
  };
  if (!SiteVisitPolicy.canReassignTarget(user, target)) {
    throw {
      status: 403,
      message: 'Pick a project manager, sales manager or agent.',
    };
  }

  // Ping-pong prevention: Cannot route to someone who has already routed it away.
  // (A change made by the office is not the person declining it.)
  const previousReassignment = await p.siteVisitReassignment.findFirst({
    where: {
      visit_id: visitId,
      from_employee_id: toEmployeeId,
      reason: { not: OFFICE_CHANGE },
    },
  });
  if (previousReassignment) {
    throw {
      status: 409,
      message: 'Cannot route to this employee. They have already declined or routed this visit.',
    };
  }

  const transition = WorkflowEngine.canTransition({
    domain: WorkflowDomain.SITE_VISIT,
    currentState: visit.status,
    action: 'REASSIGN',
    actor: user,
    entity: visit,
  });
  if (!transition.allowed) {
    throw { status: 409, message: transition.reason || 'Invalid state transition' };
  }

  const wasWithPartner = await partnerOfVisit(visit);

  const passed = await p.$transaction(
    async (tx: import('@prisma/client').Prisma.TransactionClient) => {
      // Log the reassignment hop (reason visibility restricted per §2).
      await tx.siteVisitReassignment.create({
        data: {
          visit_id: visitId,
          from_employee_id: visit.project_manager_id ?? user.employeeId,
          to_employee_id: toEmployeeId,
          reason,
        },
      });

      const updated = await tx.siteVisitBooking.update({
        where: { id: visitId },
        data: {
          status: 'PENDING_ACCEPTANCE',
          project_manager_id: toEmployeeId,
          ...(wasWithPartner ? { assigned_agent_id: null } : {}),
        },
      });

      await tx.leadActivity.create({
        data: {
          lead: { connect: { id: visit.lead_id } },
          actor: { connect: { id: user.employeeId } },
          activity_type: 'SITE_VISIT_REASSIGNED',
          notes: `Site visit ${visit.booking_code} reassigned to ${target.full_name || target.employee_code}. Reason: ${reason}`,
        },
      });

      await tx.notification.create({
        data: {
          employee_id: toEmployeeId,
          type: 'TARGET_ASSIGNED',
          title: 'Site Visit Reassigned to You',
          message: `Site visit ${visit.booking_code} has been reassigned to you for acceptance.`,
        },
      });
      // Web push to reassigned employee (outside transaction)
      notifyEmployee(
        toEmployeeId,
        {
          type: 'TARGET_ASSIGNED',
          title: 'Site Visit Reassigned to You',
          message: `Site visit ${visit.booking_code} has been reassigned to you for acceptance.`,
        },
        { skipDbNotification: true },
      ).catch((err) => logger.error('[WebPush] Site visit reassign:', err));

      return updated;
    },
  );
  if (wasWithPartner) {
    await notifyEmployee(wasWithPartner, {
      type: 'SYSTEM_ALERT',
      title: 'Site visit given to someone else',
      message: `Site visit ${visit.booking_code} no longer needs you.`,
    }).catch((err) => logger.error('[site-visit] notify removed partner:', err));
  }
  return passed;
}

/** escalate: no PM/Agent available → Marketing Director for manual resolution. */
export async function escalateVisit(user: TokenPayload, visitId: number, reason: string) {
  const visit = await findVisitForUser(user, visitId);
  if (!SiteVisitPolicy.canRouteVisit(user, visit)) {
    throw {
      status: 403,
      message: 'Forbidden: only the project manager this visit is routed to can pass it on',
    };
  }

  const transition = WorkflowEngine.canTransition({
    domain: WorkflowDomain.SITE_VISIT,
    currentState: visit.status,
    action: 'ESCALATE',
    actor: user,
    entity: visit,
  });
  if (!transition.allowed) {
    throw { status: 409, message: transition.reason || 'Invalid state transition' };
  }

  return await p.$transaction(async (tx: import('@prisma/client').Prisma.TransactionClient) => {
    // Escalated visits go to the MD(s) of the visit's company.
    const mds = await tx.employee.findMany({
      where: {
        status: 'ACTIVE',
        company_id: visit.lead.company_id,
        roles: { some: { role: { name: Roles.MD } } },
      },
      select: { id: true },
    });

    const updated = await tx.siteVisitBooking.update({
      where: { id: visitId },
      data: { status: 'ESCALATED_TO_MARKETING_DIRECTOR' },
    });

    await tx.leadActivity.create({
      data: {
        lead: { connect: { id: visit.lead_id } },
        actor: { connect: { id: user.employeeId } },
        activity_type: 'SITE_VISIT_ESCALATED',
        notes: `Site visit ${visit.booking_code} escalated to the MD. Reason: ${reason}`,
      },
    });

    if (mds.length > 0) {
      await tx.notification.createMany({
        data: mds.map((m) => ({
          employee_id: m.id,
          type: 'SYSTEM_ALERT' as const,
          title: 'Site Visit Escalated',
          message: `Site visit ${visit.booking_code} could not be assigned to a PM/Agent. Reason: ${reason}`,
        })),
      });
      // Web push to the MD(s) (outside transaction)
      for (const m of mds) {
        notifyEmployee(
          m.id,
          {
            type: 'SYSTEM_ALERT',
            title: 'Site Visit Escalated',
            message: `Site visit ${visit.booking_code} escalated — no PM/Agent available.`,
          },
          { skipDbNotification: true },
        ).catch((err) => logger.error('[WebPush] Site visit escalate:', err));
      }
    }

    return updated;
  });
}

/** Telecaller triggers day-before reconfirmation call. */
export async function reconfirmCustomer(user: TokenPayload, visitId: number) {
  const visit = await findVisitForUser(user, visitId, { verifyAction: true });
  if (!can(user, Permissions.SITE_VISITS_VERIFY, visit)) {
    throw { status: 403, message: 'Forbidden: Missing site_visits.verify permission' };
  }
  return applyTransition(
    user,
    visitId,
    'RECONFIRM_CUSTOMER',
    {},
    'SITE_VISIT_RECONFIRM_CALL',
    `Day-before reconfirmation call initiated for ${visit.booking_code}.`,
  );
}

/** Not accepted yet: a new date changes nothing about who has to answer. */
const WAITING_STATUSES = [
  'REQUESTED',
  'PENDING_ACCEPTANCE',
  'REASSIGNED',
  'ESCALATED_TO_MARKETING_DIRECTOR',
];

const onDate = (d: Date) =>
  d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });

/** What happens to a visit when its date or property changes (2026-11-27). */
function statusAfterMove(
  visit: { status: string; visit_type: string; project_manager_id: number | null },
  partnerId: number | null,
  userId: number,
): import('@prisma/client').SiteVisitStatus {
  if (visit.visit_type === 'DIRECT') return 'CONFIRMED';
  // A partner always says yes or no to the new date.
  if (partnerId) return 'PENDING_ACCEPTANCE';
  if (!visit.project_manager_id) return 'REASSIGNED';
  if (visit.status === 'CANCELLED') return 'PENDING_ACCEPTANCE';
  if (WAITING_STATUSES.includes(visit.status)) {
    return visit.status as import('@prisma/client').SiteVisitStatus;
  }
  // The person going moved it themselves, so they already agree.
  return visit.project_manager_id === userId ? 'ACCEPTED' : 'RESCHEDULE_REQUESTED';
}

/** Customer or PM requests reschedule (new date/property/unit). */
export async function rescheduleVisit(
  user: TokenPayload,
  visitId: number,
  data: { scheduled_date?: string; property_ids?: number[]; project_unit_ids?: number[] },
) {
  const visit = await findVisitForUser(user, visitId, { verifyAction: true });
  const isAuthorized =
    can(user, Permissions.SITE_VISITS_VERIFY, visit) ||
    user.roles.includes(Roles.PROJECT_MANAGER) ||
    (user.permissions || []).includes(Permissions.SITE_VISITS_ACCEPT) ||
    (user.permissions || []).includes(Permissions.SITE_VISITS_COMPLETE) ||
    visit.project_manager_id === user.employeeId;
  if (!isAuthorized) {
    throw { status: 403, message: 'Forbidden: Missing permission to reschedule this visit' };
  }
  if (visit.status === 'COMPLETED') {
    throw { status: 409, message: 'This visit is already done. Book a new visit.' };
  }
  if (visit.status === 'CANCELLED' && !SiteVisitPolicy.isManagement(user)) {
    throw {
      status: 403,
      message:
        'Only Admin, MD or the Technical Manager can bring back a cancelled visit. Book a new visit instead.',
    };
  }

  // Moving a visit follows the same two rules as booking one (2026-11-26).
  const movedTo = data.scheduled_date ? new Date(data.scheduled_date).getTime() : null;
  if (movedTo !== null && movedTo !== new Date(visit.scheduled_date).getTime()) {
    if (movedTo < Date.now() - 3600e3) {
      throw { status: 400, message: 'Pick a date and time that has not passed.' };
    }
    await assertNoOtherVisitThen(visit.lead_id, movedTo, visitId);
  }

  const partnerId = await partnerOfVisit(visit);
  const status = statusAfterMove(visit, partnerId, user.employeeId);
  const date = data.scheduled_date ? new Date(data.scheduled_date) : visit.scheduled_date;

  const extra: any = {};
  const hasPropertyIds = !!data.property_ids?.length;
  const hasUnitIds = !!data.project_unit_ids?.length;
  if (hasPropertyIds || hasUnitIds) {
    // Replace property/unit links entirely — a reschedule that changes the
    // item swaps it out rather than accumulating old + new links.
    await p.siteVisitProperty.deleteMany({ where: { visit_id: visitId } });
    await p.siteVisitProperty.createMany({
      data: [
        ...(data.property_ids ?? []).map((pid: number) => ({
          visit_id: visitId,
          property_id: pid,
        })),
        ...(data.project_unit_ids ?? []).map((uid: number) => ({
          visit_id: visitId,
          project_unit_id: uid,
        })),
      ],
    });
    if (hasPropertyIds) {
      extra.property_id = data.property_ids![0];
      extra.project_unit_id = null;
    } else {
      extra.project_unit_id = data.project_unit_ids![0];
      extra.property_id = null;
    }
  }

  const next =
    status === 'RESCHEDULE_REQUESTED'
      ? 'waiting for the person going to confirm it'
      : status === 'REASSIGNED'
        ? 'someone still has to be chosen'
        : status === 'ACCEPTED' || status === 'CONFIRMED'
          ? 'saved'
          : 'waiting to be accepted';

  const moved = await p.$transaction(async (tx) => {
    const row = await tx.siteVisitBooking.update({
      where: { id: visitId },
      data: { ...extra, scheduled_date: date, status, cancellation_reason: null },
      include: { lead: true },
    });
    // The warnings start again for the new time.
    await tx.siteVisitEscalation.deleteMany({ where: { site_visit_booking_id: visitId } });
    await tx.leadActivity.create({
      data: {
        lead_id: visit.lead_id,
        actor_id: user.employeeId,
        activity_type: 'SITE_VISIT_RESCHEDULE_REQUESTED',
        notes: `Site visit ${visit.booking_code} moved to ${onDate(date)}: ${next}.`,
      },
    });
    return row;
  });

  if (partnerId) await offerToPartner(partnerId, visit.booking_code, true);
  const tell = [partnerId ? null : visit.project_manager_id, visit.telecaller_id].filter(
    (id, i, all): id is number => !!id && id !== user.employeeId && all.indexOf(id) === i,
  );
  if (tell.length) {
    await notifyEmployee(tell, {
      type: 'SYSTEM_ALERT',
      title: 'Site visit date changed',
      message: `Site visit ${visit.booking_code} moved to ${onDate(date)}: ${next}.`,
      link: '/site-visits',
    }).catch((err) => logger.error('[site-visit] notify new date:', err));
  }
  return moved;
}

/** The person going confirms a new date, or says they cannot go. */
export async function pmReconfirm(user: TokenPayload, visitId: number, release: boolean) {
  const visit = await findVisitForUser(user, visitId);
  if (!SiteVisitPolicy.canAccept(user, visit)) {
    throw { status: 403, message: 'Forbidden: only the person going may confirm this visit' };
  }

  if (!release) {
    return applyTransition(
      user,
      visitId,
      'PM_CONFIRM',
      {},
      'SITE_VISIT_ACCEPTED',
      `New date for ${visit.booking_code} confirmed.`,
    );
  }

  const transition = WorkflowEngine.canTransition({
    domain: WorkflowDomain.SITE_VISIT,
    currentState: visit.status,
    action: 'PM_RELEASE',
    actor: user,
    entity: visit,
  });
  if (!transition.allowed)
    throw { status: 409, message: transition.reason || 'Invalid state transition' };

  // Goes to the project's own manager if that is somebody else; otherwise the booker chooses.
  const props = await p.siteVisitProperty.findMany({
    where: { visit_id: visitId },
    include: { property: true },
  });
  const projectId = props[0]?.property?.project_id ?? visit.project_id;
  const project = projectId ? await p.project.findFirst({ where: { id: projectId } }) : null;
  const own = project?.assigned_pm_id ?? null;
  const nextPm = own && own !== visit.project_manager_id ? own : null;

  const updated = await p.$transaction(
    async (tx: import('@prisma/client').Prisma.TransactionClient) => {
      const row = await tx.siteVisitBooking.update({
        where: { id: visitId },
        data: {
          status: nextPm ? 'PENDING_ACCEPTANCE' : 'REASSIGNED',
          project_manager_id: nextPm,
          assigned_agent_id: null,
        },
      });
      await tx.leadActivity.create({
        data: {
          lead: { connect: { id: visit.lead_id } },
          actor: { connect: { id: user.employeeId } },
          activity_type: 'SITE_VISIT_REASSIGNED',
          notes: `The new date for ${visit.booking_code} could not be taken; ${nextPm ? "sent to the project's manager" : 'someone else has to be chosen'}.`,
        },
      });
      return row;
    },
  );
  const tell = nextPm ?? visit.telecaller_id;
  if (tell && tell !== user.employeeId) {
    await notifyEmployee(tell, {
      type: nextPm ? 'TARGET_ASSIGNED' : 'SYSTEM_ALERT',
      title: nextPm ? 'New Site Visit to Accept' : 'Choose who takes this visit',
      message: nextPm
        ? `Site visit ${visit.booking_code} requires your acceptance.`
        : `Nobody is on site visit ${visit.booking_code}. Open Site visits and choose someone.`,
      link: '/site-visits',
    }).catch((err) => logger.error('[site-visit] notify release:', err));
  }
  return updated;
}

/** confirm: PENDING_CUSTOMER_RECONFIRMATION / RESCHEDULE_REQUESTED → CONFIRMED. */
export async function confirmVisit(user: TokenPayload, visitId: number) {
  const visit = await findVisitForUser(user, visitId, { verifyAction: true });
  if (!can(user, Permissions.SITE_VISITS_VERIFY, visit)) {
    throw { status: 403, message: 'Forbidden: Missing site_visits.verify permission' };
  }
  return applyTransition(
    user,
    visitId,
    'CONFIRM',
    {},
    'SITE_VISIT_CONFIRMED',
    `Customer confirmed site visit ${visit.booking_code}.`,
  );
}

/** Statuses in which the PM may still choose who runs the visit. */
const AGENT_ASSIGNABLE_STATUSES = ['ACCEPTED', 'PENDING_CUSTOMER_RECONFIRMATION', 'CONFIRMED'];

/**
 * assign-agent: the visit's PM (or management) names who physically runs an
 * accepted visit -- another PM/Agent, or themselves (`self`). Until this
 * existed assigned_agent_id was never set, so nobody but MD/Admin could start
 * or complete a visit.
 */
export async function assignAgent(
  user: TokenPayload,
  visitId: number,
  input: { agent_id?: number; self?: boolean; notes?: string },
) {
  const visit = await findVisitForUser(user, visitId);

  const agentId = input.self ? user.employeeId : input.agent_id!;
  const agentRow = await p.employee.findFirst({
    where: { id: agentId },
    include: { roles: { include: { role: true } } },
  });
  if (!agentRow || agentRow.status !== 'ACTIVE') {
    throw { status: 404, message: 'That employee was not found or is not active' };
  }

  if (!SiteVisitPolicy.canAssignAgent(user, visit, agentRow)) {
    throw { status: 403, message: 'Forbidden: you cannot assign an agent to this visit' };
  }
  if (!SiteVisitPolicy.canAssignAgentToVisit(user, visit)) {
    throw { status: 403, message: "Forbidden: only this visit's PM can choose who runs it" };
  }
  if (await partnerOfVisit(visit)) {
    throw {
      status: 409,
      message:
        'This visit is with a channel partner. Use "Change who goes" to give it to someone else.',
    };
  }
  const agentRoles = (agentRow.roles || []).map((er: any) => er.role?.name).filter(Boolean);
  if (!SiteVisitPolicy.canRunVisit({ roles: agentRoles })) {
    throw {
      status: 400,
      message:
        'Only a project manager, sales manager, agent or channel partner can run a site visit',
    };
  }
  if (!AGENT_ASSIGNABLE_STATUSES.includes(visit.status)) {
    throw {
      status: 409,
      message: `The visit is ${visit.status}; an agent can only be chosen once it is accepted and before it starts.`,
    };
  }

  const label = agentRow.full_name || agentRow.employee_code;
  const updated = await p.$transaction(
    async (tx: import('@prisma/client').Prisma.TransactionClient) => {
      const row = await tx.siteVisitBooking.update({
        where: { id: visitId },
        data: { assigned_agent_id: agentId },
        include: { lead: true },
      });
      await tx.leadActivity.create({
        data: {
          lead: { connect: { id: visit.lead_id } },
          actor: { connect: { id: user.employeeId } },
          activity_type: 'SITE_VISIT_AGENT_ASSIGNED',
          notes: `Site visit ${visit.booking_code} will be run by ${label}${agentId === user.employeeId ? ' (the PM themselves)' : ''}.${input.notes ? ` Instructions: ${input.notes}` : ''}`,
        },
      });
      await tx.auditEvent.create({
        data: {
          actor_id: user.employeeId,
          action: 'SITE_VISIT_AGENT_ASSIGNED',
          entity_type: 'SITE_VISIT',
          entity_id: visitId,
          old_value: JSON.stringify({ assigned_agent_id: visit.assigned_agent_id }),
          new_value: JSON.stringify({ assigned_agent_id: agentId }),
        },
      });
      if (agentId !== user.employeeId) {
        await tx.notification.create({
          data: {
            employee_id: agentId,
            type: 'TARGET_ASSIGNED',
            title: 'Site Visit Assigned to You',
            message: `You will run site visit ${visit.booking_code}.`,
          },
        });
      }
      return row;
    },
  );

  if (agentId !== user.employeeId) {
    notifyEmployee(
      agentId,
      {
        type: 'TARGET_ASSIGNED',
        title: 'Site Visit Assigned to You',
        message: `You will run site visit ${visit.booking_code}.`,
      },
      { skipDbNotification: true },
    ).catch((err) => logger.error('[WebPush] Site visit assign-agent:', err));
  }
  return updated;
}

/** start: CONFIRMED → ACTIVE (day-of). */
export async function startVisit(user: TokenPayload, visitId: number) {
  const visit = await findVisitForUser(user, visitId);
  if (!can(user, Permissions.SITE_VISITS_COMPLETE, visit)) {
    throw { status: 403, message: 'Forbidden: Missing site_visits.complete permission' };
  }
  const todayIST = getISTComponents(new Date()).dateString;
  const scheduledDayIST = getISTComponents(visit.scheduled_date).dateString;
  // A visit nobody reconfirmed with the customer (booked the same day, or after
  // the 09:00 reminder ran) may still be started once its day has come; a
  // future visit must go through reconfirmation first.
  if (visit.status !== 'CONFIRMED' && todayIST < scheduledDayIST) {
    throw {
      status: 409,
      message: `This visit is scheduled for ${scheduledDayIST}; reconfirm it with the customer first.`,
    };
  }
  // A visit can't be started before its scheduled (IST) day; management may
  // override for genuine early starts.
  if (!SiteVisitPolicy.isManagement(user)) {
    const today = todayIST;
    const scheduledDay = scheduledDayIST;
    if (today < scheduledDay) {
      throw {
        status: 409,
        message: `This visit is scheduled for ${scheduledDay}; it can't be started before that day.`,
      };
    }
  }
  return applyTransition(
    user,
    visitId,
    'START',
    {},
    'SITE_VISIT_STARTED',
    `Site visit ${visit.booking_code} started (in progress).`,
  );
}

/** complete: ACTIVE → COMPLETED, capturing per-property outcomes (multi-property §2). */
export async function completeVisit(
  user: TokenPayload,
  visitId: number,
  outcomes: any[],
  feedback_notes?: string,
  proof_photo_url?: string,
  rating?: string,
) {
  await findVisitForUser(user, visitId);
  const visit = await p.siteVisitBooking.findFirst({
    where: { id: visitId },
    include: { lead: true, site_visit_properties: true },
  });
  if (!visit) throw { status: 404, message: 'Site visit booking not found' };
  if (!can(user, Permissions.SITE_VISITS_COMPLETE, visit)) {
    throw { status: 403, message: 'Forbidden: Missing site_visits.complete permission' };
  }

  // Validate outcomes: every linked property/unit must have an outcome, with
  // reason if NOT_INTERESTED.
  const linkedProperties = visit.site_visit_properties
    .map((sp: any) => sp.property_id)
    .filter((id: number | null): id is number => id != null);
  const linkedUnits = visit.site_visit_properties
    .map((sp: any) => sp.project_unit_id)
    .filter((id: number | null): id is number => id != null);
  const providedProperties = new Set(
    outcomes.filter((o: any) => o.property_id != null).map((o: any) => o.property_id),
  );
  const providedUnits = new Set(
    outcomes.filter((o: any) => o.project_unit_id != null).map((o: any) => o.project_unit_id),
  );
  for (const pid of linkedProperties) {
    if (!providedProperties.has(pid)) {
      throw {
        status: 400,
        message: `Outcome required for every linked property. Missing property ${pid}.`,
      };
    }
  }
  for (const uid of linkedUnits) {
    if (!providedUnits.has(uid)) {
      throw {
        status: 400,
        message: `Outcome required for every linked unit. Missing unit ${uid}.`,
      };
    }
  }
  for (const o of outcomes) {
    if (o.outcome === 'NOT_INTERESTED' && (!o.outcome_reason || o.outcome_reason.trim() === '')) {
      throw { status: 400, message: 'outcome_reason is required when outcome is NOT_INTERESTED.' };
    }
  }

  // Project-based visits link no unit up front: the PM records the units the
  // customer liked afterwards. Those units must belong to this visit's project.
  const extraUnitIds = [...providedUnits].filter((id) => !linkedUnits.includes(id as number));
  if (extraUnitIds.length > 0) {
    const projectId = (visit as any).project_id as number | null;
    const found = projectId
      ? await p.projectUnit.count({
          where: {
            id: { in: extraUnitIds as number[] },
            project_id: projectId,
            company_id: visit.lead.company_id,
          },
        })
      : 0;
    if (found !== extraUnitIds.length) {
      throw {
        status: 400,
        message: "Every unit the customer liked must belong to this visit's project.",
      };
    }
  }

  const transition = WorkflowEngine.canTransition({
    domain: WorkflowDomain.SITE_VISIT,
    currentState: visit.status,
    action: 'COMPLETE',
    actor: user,
    entity: visit,
  });
  if (!transition.allowed) {
    throw { status: 409, message: transition.reason || 'Invalid state transition' };
  }

  // Array.prototype.every() is vacuously true on an empty array — guard
  // against that so a visit with no linked properties (outcomes: []) isn't
  // misreported as "all not interested".
  // A project visit with no unit picked and a "not interested" rating is a
  // drop, not a Negotiation on an estimate.
  const allNotInterested =
    (outcomes.length > 0 && outcomes.every((o: any) => o.outcome === 'NOT_INTERESTED')) ||
    (outcomes.length === 0 && rating === 'NOT_INTERESTED');

  // What goes on the lead's timeline: the real result, not just a count
  // (owner, 2026-11-21): which properties and units, liked or not and why, the
  // rating, and what the PM wrote.
  const completionNote = await describeVisitCompletion(visit, outcomes, feedback_notes, rating);

  const result = await p.$transaction(
    async (tx: import('@prisma/client').Prisma.TransactionClient) => {
      // Persist outcomes. A compound-unique lookup needs a real (non-null)
      // value for both halves of the key, so property vs. unit outcomes go
      // through different unique keys — same reasoning as
      // LeadPropertyInterest's lead_id_property_id / lead_id_project_unit_id split.
      for (const o of outcomes) {
        if (o.property_id != null) {
          await tx.siteVisitProperty.upsert({
            where: { visit_id_property_id: { visit_id: visitId, property_id: o.property_id } },
            update: { outcome: o.outcome, outcome_reason: o.outcome_reason ?? null },
            create: {
              visit_id: visitId,
              property_id: o.property_id,
              outcome: o.outcome,
              outcome_reason: o.outcome_reason ?? null,
            },
          });
        } else {
          await tx.siteVisitProperty.upsert({
            where: {
              visit_id_project_unit_id: { visit_id: visitId, project_unit_id: o.project_unit_id },
            },
            update: { outcome: o.outcome, outcome_reason: o.outcome_reason ?? null },
            create: {
              visit_id: visitId,
              project_unit_id: o.project_unit_id,
              outcome: o.outcome,
              outcome_reason: o.outcome_reason ?? null,
            },
          });
        }
      }

      const updated = await tx.siteVisitBooking.update({
        where: { id: visitId },
        data: {
          status: 'COMPLETED',
          feedback_notes,
          // Keep the photo uploaded while the visit was running.
          proof_photo_url: proof_photo_url || visit.proof_photo_url || null,
          rating: rating || null,
          completed_at: new Date(),
        },
      });

      await tx.leadActivity.create({
        data: {
          lead: { connect: { id: visit.lead_id } },
          actor: { connect: { id: user.employeeId } },
          activity_type: 'SITE_VISIT_COMPLETED',
          notes: completionNote,
        },
      });

      // §1: SITE_VISIT_COMPLETED → NEGOTIATION (any INTERESTED) or DROPPED (all NOT_INTERESTED).
      // The Lead status move is driven by the lead workflow; the service that
      // owns the lead transition will enforce it. Here we record the outcome
      // branch so the caller (route) can advance the Lead accordingly.
      // With nothing marked "interested" and not everything "not interested"
      // (e.g. a project visit where no unit was picked), the lead still goes
      // to Negotiation on an estimate -- decision D9, deliberate.
      (updated as any)._outcomeBranch = allNotInterested ? 'DROP' : 'NEGOTIATE';
      (updated as any)._dropReason = allNotInterested
        ? dropReasonFromOutcomes(
            outcomes.map((o: any) => o.outcome_reason).concat([feedback_notes]),
          )
        : undefined;

      // § Phase 7 — a completed visit always has someone who actually ran it
      // (agent takes priority over PM when both are set, matching how the
      // notification below picks a name); only request feedback when there
      // is genuinely someone to rate.
      const ratedEmployeeId = visit.assigned_agent_id || visit.project_manager_id;
      if (ratedEmployeeId) {
        (updated as any)._feedbackToken = await createFeedbackRequest(tx, visitId, ratedEmployeeId);
      }

      return updated;
    },
    // Several sequential writes over a remote database: the 5 s default is too tight.
    { maxWait: 10000, timeout: 30000 },
  );

  // Outside the transaction (this I/O must never roll back the visit
  // completion itself), but still awaited: dispatchFeedbackRequestNotification
  // catches its own errors internally, so awaiting it costs a little
  // latency without risking the request path — and avoids an unhandled,
  // untracked background promise outliving the request.
  if ((result as any)._feedbackToken) {
    await dispatchFeedbackRequestNotification(visitId, (result as any)._feedbackToken);
  }

  // Running a visit with a photo and feedback counts as being at work that day.
  await markPresentFromVisit(visitId);

  return result;
}

const OUTCOME_WORD: Record<string, string> = {
  INTERESTED: 'Interested',
  NOT_INTERESTED: 'Not interested',
  MAYBE: 'Maybe',
  NEUTRAL: 'Maybe',
};
const pretty = (v: string) =>
  v
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/^./, (c) => c.toUpperCase());

/** The timeline text for a completed visit: outcome per property or unit, rating and feedback. */
export async function describeVisitCompletion(
  visit: { booking_code: string; project_id?: number | null },
  outcomes: any[],
  feedback_notes?: string,
  rating?: string,
): Promise<string> {
  const propertyIds = outcomes.filter((o) => o.property_id != null).map((o) => o.property_id);
  const unitIds = outcomes.filter((o) => o.project_unit_id != null).map((o) => o.project_unit_id);
  const [props, units] = await Promise.all([
    propertyIds.length
      ? p.property.findMany({
          where: { id: { in: propertyIds } },
          select: { id: true, title: true },
        })
      : [],
    unitIds.length
      ? p.projectUnit.findMany({
          where: { id: { in: unitIds } },
          select: { id: true, unit_number: true, project: { select: { name: true } } },
        })
      : [],
  ]);
  const propName = new Map(props.map((x: any) => [x.id, x.title as string]));
  const unitName = new Map(
    units.map((x: any) => [
      x.id,
      `${x.project?.name ? `${x.project.name}, ` : ''}unit ${x.unit_number}`,
    ]),
  );
  const lines = outcomes.map((o) => {
    const name =
      o.property_id != null ? propName.get(o.property_id) : unitName.get(o.project_unit_id);
    const word = OUTCOME_WORD[o.outcome] || pretty(String(o.outcome || ''));
    return `${name || 'Property'}: ${word}${o.outcome_reason ? ` (${o.outcome_reason})` : ''}`;
  });
  const parts = [`Site visit ${visit.booking_code} completed.`];
  if (rating) parts.push(`Customer response: ${pretty(rating)}.`);
  if (lines.length) parts.push(lines.join('; ') + '.');
  if (feedback_notes?.trim()) parts.push(`Feedback: ${feedback_notes.trim()}`);
  return parts.join(' ');
}
