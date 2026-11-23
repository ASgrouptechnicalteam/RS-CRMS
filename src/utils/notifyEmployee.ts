import { logger } from './logger';
import { Roles } from '../shared';
import { createMdLookup, isImportantForMd } from './mdNotificationPolicy';
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

const isManagingDirector = createMdLookup((employeeId) =>
  p.employeeRole.count({ where: { employee_id: employeeId, role: { name: Roles.MD } } }),
);

/** The same message sent to the same person again within this window is dropped. */
const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

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
      if (!isImportantForMd(payload) && (await isManagingDirector(employeeId))) continue;

      // Two copies of a scheduled job (or a retry) used to send the same alert twice,
      // seconds apart. An identical alert in the last few minutes is not sent again.
      const duplicate = await p.notification.count({
        where: {
          employee_id: employeeId,
          type: payload.type,
          title: payload.title,
          message: payload.message,
          created_at: { gt: new Date(Date.now() - DUPLICATE_WINDOW_MS) },
        },
      });
      if (duplicate > 0) continue;

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
