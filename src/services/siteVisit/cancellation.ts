import { prisma } from '../../lib/prisma';
import { TokenPayload } from '../../utils/jwt';
import { Permissions } from '../../shared';
import { can } from '../../authz/authorization';
import { SiteVisitPolicy } from '../../policies/siteVisit.policy';
import { applyTransition, findVisitForUser } from './shared';
import { notifyEmployee } from '../../utils/notifyEmployee';
import { logger } from '../../utils/logger';

const p = prisma;

async function resolveCancellerName(user: TokenPayload, isManagement: boolean): Promise<string> {
  if (user.employeeId) {
    const emp = await p.employee.findUnique({
      where: { id: user.employeeId },
      select: { full_name: true },
    });
    if (emp?.full_name) return emp.full_name;
  }
  if (user.employeeCode) return user.employeeCode;
  return isManagement ? 'Management' : 'Staff';
}

/** Everyone on the visit (manager, field agent or partner, booker) is told it is off. */
async function tellEveryone(user: TokenPayload, visit: any, reason: string | undefined) {
  const isManagement = SiteVisitPolicy.canCancelAtAnyTime(user);
  const by = await resolveCancellerName(user, isManagement);
  const people = [visit.project_manager_id, visit.assigned_agent_id, visit.telecaller_id].filter(
    (id, i, all): id is number => !!id && id !== user.employeeId && all.indexOf(id) === i,
  );
  if (!people.length) return;
  await notifyEmployee(people, {
    type: 'SYSTEM_ALERT',
    title: isManagement ? 'Site Visit Cancelled by Management' : 'Site Visit Cancelled',
    message: `Site visit ${visit.booking_code}${visit.lead?.customer_name && visit.status !== 'PENDING_ACCEPTANCE' ? ` (${visit.lead.customer_name})` : ''} was cancelled by ${by}.${reason ? ` Reason: ${reason}` : ''}`,
    link: '/site-visits',
  }).catch((err) => logger.error('[site-visit] notify cancel:', err));
}

/** cancel: any active state → CANCELLED. Admin and Technical Manager can cancel at any time. */
export async function cancelVisit(user: TokenPayload, visitId: number, reason?: string) {
  const visit = await findVisitForUser(user, visitId);
  const isManagement = SiteVisitPolicy.canCancelAtAnyTime(user);
  if (
    !isManagement &&
    !can(user, Permissions.SITE_VISITS_COMPLETE, visit) &&
    !SiteVisitPolicy.canHoldOrInitiateCancel(user, visit)
  ) {
    throw { status: 403, message: 'Forbidden: Missing permission to cancel site visits' };
  }
  const result = await applyTransition(
    user,
    visitId,
    'CANCEL',
    {
      cancellation_reason: reason || null,
    },
    'SITE_VISIT_CANCELLED',
    `Site visit ${visit.booking_code} cancelled.${reason ? ` Reason: ${reason}` : ''}`,
  );

  await tellEveryone(user, visit, reason);

  return result;
}

// ==========================================
// Phase D: Site Visit Hold/Cancel Flow
// ==========================================

/** HOLD: Reconfirmation fails -> ON_HOLD. */
export async function holdVisit(user: TokenPayload, visitId: number) {
  const visit = await findVisitForUser(user, visitId);
  if (!SiteVisitPolicy.canHoldOrInitiateCancel(user, visit)) {
    throw { status: 403, message: 'Forbidden: Only the assigned telecaller can hold this visit.' };
  }

  const result = await applyTransition(
    user,
    visitId,
    'HOLD',
    {},
    'SITE_VISIT_ON_HOLD',
    `Site visit ${visit.booking_code} placed ON_HOLD (Customer unresponsive).`,
  );

  // The person going: our manager, or the channel partner.
  const going = visit.project_manager_id ?? visit.assigned_agent_id;
  if (going) {
    await p.notification.create({
      data: {
        employee_id: going,
        type: 'SYSTEM_ALERT',
        title: 'Customer not reached',
        message: `Site visit ${visit.booking_code}: the customer could not be reached to confirm.`,
      },
    });
  }
  return result;
}

/** INITIATE_CANCEL: 1 hour before visit, Telecaller requests PM cross-check. */
export async function initiateCancellation(user: TokenPayload, visitId: number) {
  const visit = await findVisitForUser(user, visitId);
  if (!SiteVisitPolicy.canHoldOrInitiateCancel(user, visit)) {
    throw {
      status: 403,
      message: 'Forbidden: Only the assigned telecaller can initiate cancellation cross-check.',
    };
  }

  // 1-hour-before-visit retry check
  const now = new Date();
  const oneHourBefore = new Date(visit.scheduled_date.getTime() - 60 * 60 * 1000);
  if (now < oneHourBefore) {
    throw {
      status: 400,
      message: 'Cannot initiate cancellation cross-check until 1 hour before the scheduled visit.',
    };
  }

  const result = await applyTransition(
    user,
    visitId,
    'INITIATE_CANCEL',
    {},
    'SITE_VISIT_ON_HOLD',
    `Site visit ${visit.booking_code} cancellation initiated (PM cross-check pending).`,
  );

  if (visit.project_manager_id) {
    await p.notification.create({
      data: {
        employee_id: visit.project_manager_id,
        type: 'ACTION_REQUIRED',
        title: 'Cross-Check: Cancellation Pending',
        message: `Telecaller cannot reach customer for ${visit.booking_code}. Have they responded to you? Please confirm or reject cancellation.`,
      },
    });
  }
  return result;
}

/** PM_CANCEL_REJECT: PM indicates customer has responded, reverting to PENDING_CUSTOMER_RECONFIRMATION. */
export async function rejectCancellation(user: TokenPayload, visitId: number) {
  const visit = await findVisitForUser(user, visitId);
  if (!SiteVisitPolicy.canConfirmCancel(user, visit)) {
    throw { status: 403, message: 'Forbidden: Only the assigned PM can reject this cancellation.' };
  }

  const result = await applyTransition(
    user,
    visitId,
    'PM_CANCEL_REJECT',
    {},
    'SITE_VISIT_ON_HOLD',
    `PM confirmed customer responded for ${visit.booking_code}. Reverted to active reconfirmation.`,
  );

  if (visit.telecaller_id) {
    await p.notification.create({
      data: {
        employee_id: visit.telecaller_id,
        type: 'SYSTEM_ALERT',
        title: 'Cancellation Rejected by PM',
        message: `PM indicates the customer for ${visit.booking_code} has responded. Visit is active again.`,
      },
    });
  }
  return result;
}

/**
 * Cancel with a reason: the person going, or the booker before the visit has started (2026-11-27). Admin, MD and
 * the Technical Manager can cancel at any time.
 */
export async function confirmCancellation(user: TokenPayload, visitId: number, reason: string) {
  const visit = await findVisitForUser(user, visitId);
  const isManagement = SiteVisitPolicy.canCancelAtAnyTime(user);
  const booker = visit.telecaller_id === user.employeeId && visit.status !== 'ACTIVE';
  if (!isManagement && !booker && !SiteVisitPolicy.canConfirmCancel(user, visit)) {
    throw {
      status: 403,
      message:
        'Only the person going, the person who booked it (before it starts) or management can cancel this visit.',
    };
  }
  if (!reason || reason.trim() === '') {
    throw { status: 400, message: 'A cancellation reason must be provided.' };
  }

  // Choose action dynamically so both PM cross-check and direct cancel work seamlessly
  const action =
    visit.status === 'CANCELLATION_PENDING_PM_CONFIRMATION' ? 'CONFIRM_CANCEL' : 'CANCEL';

  // Pass cancellation details in the extra update payload
  const result = await applyTransition(
    user,
    visitId,
    action,
    {
      cancellation_reason: reason,
      // Only the visit's own PM is recorded as the one who confirmed; a manager who cancels is not.
      ...(user.employeeId && user.employeeId === visit.project_manager_id
        ? { cancellation_confirmed_by_pm_id: user.employeeId }
        : {}),
    },
    'SITE_VISIT_CANCELLED',
    `Site visit ${visit.booking_code} cancelled. Reason: ${reason}`,
  );

  await tellEveryone(user, visit, reason);

  // No-Show Flagging (2 No-shows)
  const normalizedReason = reason.toLowerCase().replace(/[\s-]/g, '');
  if (normalizedReason.includes('noshow') && visit.lead.assigned_to_id) {
    // Find telecaller's reporting manager
    const telecaller = await p.employee.findUnique({
      where: { id: visit.lead.assigned_to_id },
      select: { reporting_manager_id: true },
    });

    if (telecaller && telecaller.reporting_manager_id) {
      // Count previous no-shows
      const previousNoShows = await p.siteVisitBooking.count({
        where: {
          lead_id: visit.lead_id,
          status: 'CANCELLED',
          cancellation_reason: { contains: 'show' },
        },
      });

      // This count includes the current one since applyTransition just updated it
      if (previousNoShows >= 2) {
        await p.notification.create({
          data: {
            employee_id: telecaller.reporting_manager_id,
            type: 'SYSTEM_ALERT',
            title: 'Customer No-Show Cap Exceeded',
            message: `Customer ${visit.lead.customer_name} has hit the 2 No-Show cap. Please review this lead with the assigned telecaller.`,
          },
        });
      }
    }
  }

  return result;
}
