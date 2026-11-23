/**
 * mdNotificationPolicy.ts
 *
 * The Managing Director only gets notifications that need a decision or are urgent
 * (owner, 2026-11-22: "don't send all notifications to me, only important ones").
 * Everything else is simply not created for the MD; the people who do that work
 * (managers, HR, finance, the technical team) still get theirs.
 *
 * Important for the MD:
 *  - something waiting for the MD's approval (project, expense refund, property),
 *  - a site visit nobody accepted that is now overdue,
 *  - the weekly report,
 *  - a request in the approvals queue (leave, early checkout, work from home).
 *
 * This file has no database access so it can be used from lib/prisma.ts (which
 * applies it to every Notification row, whichever code path creates it) and from
 * notifyEmployee.
 */

const MD_IMPORTANT_TYPES = new Set([
  'PROJECT_REVIEW_MD',
  'REMINDER_PROJECT_REVIEWS',
  'EXPENSE_REFUND_AWAITING_MD',
  'SITE_VISIT_ESCALATED',
  'REPORT_READY',
  // A lead referred to a partner: sent, partner did not respond, partner declined, booked.
  'CP_REFERRAL_SENT',
  'CP_REFERRAL_STALE',
  'CP_REFERRAL_DECLINED',
  'CP_REFERRAL_BOOKED',
]);

export function isImportantForMd(n: { type?: string; title?: string; link?: string }): boolean {
  const type = n.type || '';
  if (MD_IMPORTANT_TYPES.has(type)) return true;
  if (n.link && n.link.startsWith('/approvals')) return true;
  if (/approval/i.test(n.title || '') && /^SYSTEM/.test(type)) return true;
  return false;
}

/**
 * Remembers who is a Managing Director for a minute, so a batch of notifications does
 * not ask the database for each one. `countMdRoles(id)` returns how many MD roles the
 * person has.
 */
export function createMdLookup(countMdRoles: (employeeId: number) => Promise<number>) {
  const cache = new Map<number, { isMd: boolean; at: number }>();
  return async (employeeId: number): Promise<boolean> => {
    const hit = cache.get(employeeId);
    if (hit && Date.now() - hit.at < 60_000) return hit.isMd;
    const isMd = (await countMdRoles(employeeId)) > 0;
    cache.set(employeeId, { isMd, at: Date.now() });
    return isMd;
  };
}
