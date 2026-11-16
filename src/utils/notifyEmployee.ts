import { logger } from './logger';
/**
 * notifyEmployee.ts
 *
 * Universal notification dispatcher. Call this from any route whenever
 * an employee's data changes or an action requires their attention.
 *
 *  1. Saves an in-app Notification record to the DB
 *  2. The Web Push to the person's devices is sent by the Prisma middleware
 *     (lib/prisma.ts) for every Notification row, whichever code path created
 *     it, so this function never pushes by itself (no double push).
 */

import { prisma } from '../lib/prisma';
import { runWithPushLink } from './pushDispatch';

const p = prisma;

export interface NotifyPayload {
  type: string; // e.g. 'EXPENSE_REFUND_APPROVED', 'SALARY_CHANGED'
  title: string;
  message: string;
  link?: string; // Optional deep-link for when user taps notification
  /** Saved with the in-app record so tapping it in the bell opens the item. */
  entity_type?: string; // e.g. 'PROJECT'
  entity_id?: number;
}

export interface NotifyOptions {
  /** When true, skips the DB notification create (row already created elsewhere, and so already pushed). */
  skipDbNotification?: boolean;
}

/**
 * Notify one or more employees by their DB IDs.
 */
export async function notifyEmployee(
  employeeIds: number | number[],
  payload: NotifyPayload,
  options?: NotifyOptions,
): Promise<void> {
  if (options?.skipDbNotification) return;
  const ids = Array.isArray(employeeIds) ? employeeIds : [employeeIds];

  for (const employeeId of ids) {
    try {
      // The middleware pushes this row; the link travels to it via the store.
      // (async + await inside: Prisma runs the query lazily, when awaited, and
      // that must happen inside the context.)
      await runWithPushLink(
        payload.link,
        async () =>
          await p.notification.create({
            data: {
              employee_id: employeeId,
              type: payload.type,
              title: payload.title,
              message: payload.message,
              is_read: false,
              ...(payload.entity_type && payload.entity_id != null
                ? { entity_type: payload.entity_type, entity_id: payload.entity_id }
                : {}),
            },
          }),
      );
    } catch (err) {
      logger.error(
        `[NotifyEmployee] Failed to create in-app notification for employee ${employeeId}:`,
        err,
      );
    }
  }
}
