import type { Prisma } from '@prisma/client';

// Visits still waiting on or planned with the PM. A visit already under way
// (ACTIVE) stays with whoever is running it, and finished ones keep their history.
const OPEN_VISIT_STATUSES = [
  'REQUESTED',
  'PENDING_ACCEPTANCE',
  'REASSIGNED',
  'ACCEPTED',
  'PENDING_CUSTOMER_RECONFIRMATION',
  'RESCHEDULE_REQUESTED',
  'PENDING_PM_RECONFIRMATION',
  'CONFIRMED',
  'ON_HOLD',
  'CANCELLATION_PENDING_PM_CONFIRMATION',
] as const;

/** When a project's or property's PM is replaced, its open visits go with it. */
export async function moveOpenVisitsToNewPm(
  tx: Prisma.TransactionClient,
  where: { project_id: number } | { property_id: number },
  oldPmId: number,
  newPmId: number,
): Promise<number> {
  const { count } = await tx.siteVisitBooking.updateMany({
    where: { ...where, project_manager_id: oldPmId, status: { in: [...OPEN_VISIT_STATUSES] } },
    data: { project_manager_id: newPmId },
  });
  return count;
}
