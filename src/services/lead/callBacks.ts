import { Prisma } from '@prisma/client';

/** Call-back tasks are the follow-up tasks logCall creates, titled "Call back <customer>". */
export const CALL_BACK_TITLE_PREFIX = 'Call back ';

/**
 * Closes a lead's open call-back tasks.
 *
 * Nothing used to close them: logging the promised call, transferring the
 * lead, dropping it or booking it all left every earlier "Call back" task
 * pending until it went overdue -- so a telecaller who did exactly what the
 * task asked still collected an overdue penalty, and the dashboard's
 * "call-backs due" count never went down.
 *
 * COMPLETED = the call was made (no performance points: those are awarded only
 * through the task-status route). CANCELLED = the task no longer applies
 * (lead moved to someone else, dropped or booked).
 */
/**
 * Moves a lead's call-backs to its new owner: the customer still expects that call. One
 * already overdue stays on the old owner's record, so the mark stays where it was earned,
 * and the new owner starts fresh with a new date.
 */
export async function moveCallBackTasks(
  tx: Prisma.TransactionClient,
  leadId: number,
  fromId: number,
  toId: number,
): Promise<number> {
  const now = new Date();
  const mine = {
    lead_id: leadId,
    assignee_id: fromId,
    title: { startsWith: CALL_BACK_TITLE_PREFIX },
  };
  await tx.task.updateMany({
    where: { ...mine, status: { in: ['PENDING', 'IN_PROGRESS'] }, target_date: { lt: now } },
    data: { status: 'OVERDUE' },
  });
  const moved = await tx.task.updateMany({
    where: { ...mine, status: { in: ['PENDING', 'IN_PROGRESS'] } },
    data: { assignee_id: toId },
  });
  if (moved.count > 0) return moved.count;

  const missed = await tx.task.findFirst({
    where: { ...mine, status: 'OVERDUE' },
    orderBy: { target_date: 'desc' },
  });
  if (!missed) return 0;
  await tx.task.create({
    data: {
      title: missed.title,
      task_type: 'CALL',
      description: missed.description,
      assignee_id: toId,
      created_by: toId,
      status: 'PENDING',
      priority: 'HIGH',
      target_date: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      lead_id: leadId,
    },
  });
  return 1;
}

export async function closeCallBackTasks(
  tx: Prisma.TransactionClient,
  leadId: number,
  opts: { outcome: 'COMPLETED' | 'CANCELLED'; assigneeId?: number },
): Promise<number> {
  const res = await tx.task.updateMany({
    where: {
      lead_id: leadId,
      title: { startsWith: CALL_BACK_TITLE_PREFIX },
      status: { notIn: ['COMPLETED', 'CANCELLED', 'NOT_COMPLETED', 'BLOCKED'] },
      ...(opts.assigneeId !== undefined ? { assignee_id: opts.assigneeId } : {}),
    },
    data: {
      status: opts.outcome,
      ...(opts.outcome === 'COMPLETED' ? { completed_at: new Date() } : {}),
    },
  });
  return res.count;
}
