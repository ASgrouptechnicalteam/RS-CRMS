import { prisma } from '../../lib/prisma';
import { TokenPayload } from '../../utils/jwt';
import { Roles } from '../../shared';
import { visibleEmployees } from '../../authz/dataScope';
import { SiteVisitPolicy } from '../../policies/siteVisit.policy';
import { notifyEmployee } from '../../utils/notifyEmployee';
import { logger } from '../../utils/logger';
import { findVisitForUser } from './shared';

/**
 * "Assign PM" when a visit is booked (owner, 2026-11-27): the booker may name one of our project managers or a
 * channel partner. A project manager gets it for acceptance as usual. A channel partner is offered the visit
 * (waiting, nobody in the PM box) and accepts or declines it in the partner portal; a declined visit comes back
 * to the booker, who names someone else. Management can change who goes at any time (see assignAgain).
 */
/** The history note when management gives a visit to someone else. */
export const OFFICE_CHANGE = 'Changed by the office';

export type VisitAssignee = { kind: 'PM' | 'PARTNER'; id: number; name: string };

export async function resolveAssignee(companyId: number, id: number): Promise<VisitAssignee> {
  const person = await prisma.employee.findFirst({
    where: { id, company_id: companyId, status: 'ACTIVE', ...visibleEmployees },
    include: { roles: { include: { role: true } } },
  });
  const roles: string[] = person?.roles.map((r) => r.role.name) ?? [];
  const kind = roles.includes(Roles.CHANNEL_PARTNER_EXTERNAL)
    ? 'PARTNER'
    : roles.includes(Roles.PROJECT_MANAGER)
      ? 'PM'
      : null;
  if (!person || !kind) {
    throw { status: 400, message: 'Pick an active project manager or channel partner.' };
  }
  return { kind, id: person.id, name: person.full_name || person.employee_code };
}

/** The choices for the booker, with the project's own manager marked. */
export async function listAssignees(user: TokenPayload, projectId?: number) {
  const people = await prisma.employee.findMany({
    where: {
      company_id: user.companyId,
      status: 'ACTIVE',
      ...visibleEmployees,
      roles: {
        some: {
          role: { name: { in: [Roles.PROJECT_MANAGER, Roles.CHANNEL_PARTNER_EXTERNAL] } },
        },
      },
    },
    select: {
      id: true,
      full_name: true,
      employee_code: true,
      roles: { select: { role: { select: { name: true } } } },
    },
    orderBy: { full_name: 'asc' },
  });
  const project = projectId
    ? await prisma.project.findFirst({
        where: { id: projectId, company_id: user.companyId },
        select: { assigned_pm_id: true },
      })
    : null;
  const choices = people.map((e) => ({
    id: e.id,
    name: e.full_name || e.employee_code,
    code: e.employee_code,
    partner: e.roles.some((r) => r.role.name === Roles.CHANNEL_PARTNER_EXTERNAL),
  }));
  return {
    project_managers: choices.filter((c) => !c.partner),
    partners: choices.filter((c) => c.partner),
    project_manager_id: project?.assigned_pm_id ?? null,
  };
}

/** Tells the chosen channel partner that a visit is waiting for their answer. */
export async function offerToPartner(partnerId: number, bookingCode: string, changed = false) {
  const message = changed
    ? `Visit ${bookingCode} has a new date. Open Visits and accept or decline it.`
    : `A site visit (${bookingCode}) is waiting for you. Open Visits and accept or decline it.`;
  await notifyEmployee(partnerId, {
    type: 'TARGET_ASSIGNED',
    title: changed ? 'Visit date changed' : 'New site visit for you',
    message,
  }).catch((err) => logger.error('[site-visit] notify partner:', err));
}

/** The channel partner this visit is with, when it is not one of our project managers' visits. */
export async function partnerOfVisit(visit: {
  project_manager_id: number | null;
  assigned_agent_id: number | null;
}): Promise<number | null> {
  if (visit.project_manager_id || !visit.assigned_agent_id) return null;
  const partner = await prisma.employee.findFirst({
    where: {
      id: visit.assigned_agent_id,
      roles: { some: { role: { name: Roles.CHANNEL_PARTNER_EXTERNAL } } },
    },
    select: { id: true },
  });
  return partner?.id ?? null;
}

/**
 * Name who takes a visit. Admin, MD and the Technical Manager can change it at any time while the visit is open
 * (owner, 2026-11-27); the booker only when nobody is on it (a partner declined, or the person going gave it back).
 * Whoever is chosen has to accept.
 */
export async function assignAgain(user: TokenPayload, visitId: number, assigneeId: number) {
  const visit = await findVisitForUser(user, visitId);
  const management = SiteVisitPolicy.isManagement(user);
  if (!management && visit.telecaller_id !== user.employeeId) {
    throw {
      status: 403,
      message: 'Only the person who booked this visit or management can assign it again.',
    };
  }
  if (visit.visit_type !== 'SCHEDULED') {
    throw { status: 409, message: 'Nobody from the company is assigned to this kind of visit.' };
  }
  if (['COMPLETED', 'CANCELLED'].includes(visit.status)) {
    throw { status: 409, message: 'This visit is already finished.' };
  }
  if (!management && visit.status !== 'REASSIGNED') {
    throw {
      status: 409,
      message: 'Only Admin, MD or the Technical Manager can change who goes now.',
    };
  }
  const to = await resolveAssignee(visit.lead.company_id, assigneeId);
  const partnerBefore = await partnerOfVisit(visit);
  const holder = visit.project_manager_id ?? partnerBefore;
  const stuck = ['REASSIGNED', 'ESCALATED_TO_MARKETING_DIRECTOR'].includes(visit.status);
  if (!stuck && holder === to.id) {
    throw { status: 409, message: `This visit is already with ${to.name}.` };
  }
  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.siteVisitBooking.update({
      where: { id: visitId },
      data: {
        status: 'PENDING_ACCEPTANCE',
        project_manager_id: to.kind === 'PM' ? to.id : null,
        assigned_agent_id: to.kind === 'PARTNER' ? to.id : null,
      },
    });
    await tx.siteVisitEscalation.deleteMany({ where: { site_visit_booking_id: visitId } });
    // Keeps the visit visible to the person it was taken from, and shows who changed it.
    if (visit.project_manager_id && visit.project_manager_id !== to.id) {
      await tx.siteVisitReassignment.create({
        data: {
          visit_id: visitId,
          from_employee_id: visit.project_manager_id,
          to_employee_id: to.id,
          reason: OFFICE_CHANGE,
        },
      });
    }
    await tx.leadActivity.create({
      data: {
        lead_id: visit.lead_id,
        actor_id: user.employeeId,
        activity_type: 'SITE_VISIT_REASSIGNED',
        notes: `Site visit ${visit.booking_code} sent to ${to.name}${to.kind === 'PARTNER' ? ' (channel partner)' : ''} for acceptance.`,
      },
    });
    return row;
  });
  const dropped = [visit.project_manager_id, visit.assigned_agent_id].filter(
    (id, i, all): id is number =>
      !!id && id !== to.id && id !== user.employeeId && all.indexOf(id) === i,
  );
  if (dropped.length) {
    await notifyEmployee(dropped, {
      type: 'SYSTEM_ALERT',
      title: 'Site visit given to someone else',
      message: `Site visit ${visit.booking_code} no longer needs you.`,
    }).catch((err) => logger.error('[site-visit] notify removed:', err));
  }
  if (to.kind === 'PARTNER') await offerToPartner(to.id, visit.booking_code);
  else {
    await notifyEmployee(to.id, {
      type: 'TARGET_ASSIGNED',
      title: 'New Site Visit to Accept',
      message: `Site visit ${visit.booking_code} requires your acceptance.`,
      link: '/site-visits',
    }).catch((err) => logger.error('[site-visit] notify PM:', err));
  }
  return updated;
}
