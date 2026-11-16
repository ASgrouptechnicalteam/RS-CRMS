import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import webpush from 'web-push';
import { logger } from './logger';

/**
 * Phone / browser push for every Notification row.
 *
 * The Prisma middleware in lib/prisma.ts calls pushForNotificationRows() after
 * any Notification is created, so every code path pushes, not only
 * notifyEmployee. Nothing here may throw into, slow down or roll back the
 * database write.
 */

export interface PushPayload {
  title: string;
  body: string;
  link?: string;
  type?: string;
  id?: number | string;
  icon?: string;
  badge?: string;
}

export interface PushFailure {
  status: number | null;
  reason: string;
}

export interface PushResult {
  devices: number;
  sent: number;
  failed: PushFailure[];
}

// notifyEmployee knows the deep link; the Notification table has no link
// column, so it hands it to the middleware through this store.
const linkStore = new AsyncLocalStorage<{ link?: string }>();
export const runWithPushLink = <T>(link: string | undefined, fn: () => Promise<T>): Promise<T> =>
  linkStore.run({ link }, fn);
export const currentPushLink = (): string | undefined => linkStore.getStore()?.link;

export const vapidConfig = () => {
  const publicKey = process.env.VAPID_PUBLIC_KEY || '';
  const privateKey = process.env.VAPID_PRIVATE_KEY || '';
  if (!publicKey || !privateKey) return null;
  return {
    subject: process.env.VAPID_SUBJECT || 'mailto:admin@radharealhomeproperties.com',
    publicKey,
    privateKey,
  };
};
export const isPushConfigured = () => vapidConfig() !== null;

const TTL_SECONDS = 24 * 60 * 60;

const shortReason = (err: any): string =>
  String(err?.body || err?.message || 'unknown error')
    .replace(/\s+/g, ' ')
    .slice(0, 120);

/**
 * Send one payload to every device of one employee, in parallel.
 * Never throws.
 */
export async function sendPushToEmployee(
  employeeId: number,
  payload: PushPayload,
): Promise<PushResult> {
  const result: PushResult = { devices: 0, sent: 0, failed: [] };
  try {
    const vapid = vapidConfig();
    if (!vapid) return result;
    // Loaded here: lib/prisma imports this file.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { prisma } = require('../lib/prisma');
    const subs = await prisma.pushSubscription.findMany({ where: { employee_id: employeeId } });
    result.devices = subs.length;
    if (!subs.length) return result;

    const body = JSON.stringify({
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      link: '/',
      ...payload,
      id: payload.id ?? randomUUID(),
    });

    await Promise.all(
      subs.map(async (sub: any) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            body,
            { vapidDetails: vapid, urgency: 'high', TTL: TTL_SECONDS },
          );
          result.sent++;
        } catch (err: any) {
          const status = typeof err?.statusCode === 'number' ? err.statusCode : null;
          if (status === 404 || status === 410) {
            await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {});
          }
          const reason = shortReason(err);
          result.failed.push({ status, reason });
          logger.warn(`[WebPush] subscription ${sub.id} failed: status=${status} ${reason}`);
        }
      }),
    );
  } catch (err: any) {
    logger.warn(`[WebPush] push for employee ${employeeId} failed: ${shortReason(err)}`);
  }
  return result;
}

/** Where tapping a notification should go, from its type and entity. */
export function deriveLink(
  type?: string | null,
  entityType?: string | null,
  entityId?: number | null,
): string {
  const et = String(entityType || '').toUpperCase();
  const t = String(type || '').toUpperCase();
  const id = entityId ? `/${entityId}` : '';
  if (et === 'LEAD') return id ? `/leads${id}` : '/leads';
  if (et === 'MASTER_LEAD_BATCH') return '/leads';
  if (et === 'SITE_VISIT') return '/site-visits';
  if (et === 'TASK') return '/tasks';
  if (et === 'PROJECT') return id ? `/projects${id}` : '/projects';
  if (et === 'PROPERTY') return '/properties';
  if (et === 'BOOKING') return id ? `/bookings${id}` : '/bookings';
  if (et === 'DAILY_REPORT' || et === 'DAILY_TARGET') return '/my-day';
  if (et === 'ATTENDANCE_PROPOSAL') return '/approvals';
  if (et === 'ATTENDANCE_LOG' || et === 'EXPENSE_REFUND') return '/requests';
  if (et === 'PERFORMANCE_TARGET') return '/my-performance';
  if (et === 'CUSTOMER') return '/customers';
  if (et === 'COMPLAINT') return '/complaints';
  if (t.includes('SITE_VISIT')) return '/site-visits';
  if (t.includes('DEMO')) return '/demos';
  if (t.includes('TASK')) return '/tasks';
  if (t.includes('LEAD') || t === 'ASSIGNED_TO_AGENT' || t === 'CALL_LOGGED') return '/leads';
  if (t.includes('PROJECT')) return '/projects';
  if (t.includes('PROPERTY')) return '/properties';
  if (t.includes('BOOKING')) return '/bookings';
  if (t.includes('APPROVAL') || t.includes('PROPOSAL')) return '/approvals';
  if (
    ['ATTENDANCE', 'LEAVE', 'EARLY_CHECKOUT', 'FIELD_WORK', 'LATE_CHECKIN', 'REQUEST'].some((k) =>
      t.includes(k),
    )
  )
    return '/requests';
  if (t.includes('REPORT')) return '/reports';
  if (t.includes('TARGET') || t.includes('PERFORMANCE')) return '/my-performance';
  return '/';
}

/**
 * Called by the Prisma middleware with the rows just written (or, for
 * createMany, the rows that were passed in). Schedules the pushes on the
 * next tick and returns at once.
 */
export function pushForNotificationRows(rows: any[], opts: { link?: string; delayMs?: number }) {
  try {
    if (!isPushConfigured()) return;
    const list = rows.filter((r) => r && typeof r.employee_id === 'number');
    if (!list.length) return;
    const fire = () => {
      for (const r of list) {
        void sendPushToEmployee(r.employee_id, {
          title: String(r.title ?? 'Notification'),
          body: String(r.message ?? ''),
          type: r.type,
          id: r.id ?? randomUUID(),
          link: opts.link || deriveLink(r.type, r.entity_type, r.entity_id),
        }).catch(() => {});
      }
    };
    setImmediate(() => {
      if (opts.delayMs) {
        const t = setTimeout(fire, opts.delayMs);
        t.unref?.();
      } else fire();
    });
  } catch {
    /* never break the write */
  }
}
