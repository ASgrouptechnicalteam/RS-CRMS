import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';
import { notifyEmployee } from '../utils/notifyEmployee';
import { Roles } from '../shared';
import { getISTComponents, getISTMidnightInstant } from '../utils/time';
import { WorkLogEntry } from '../routes/workLog';

/**
 * Work updates (owner, 2026-11-16): the digital team works outside the CRM, so
 * they tap Start when they begin a task and Done when it is finished. Each
 * step is saved at once and shows on Team Today straight away; finished work
 * fills in their day-end report, where they only write the summary.
 *
 * Digital team only for now.
 */
export const WORK_UPDATE_ROLES: string[] = [
  Roles.DIGITAL_MARKETING_HEAD,
  Roles.DIGITAL_MARKETING_EXECUTIVE,
  Roles.DIGITAL_LEAD_OPERATOR,
];

export const isWorkUpdateRole = (roles: string[]) =>
  roles.some((r) => WORK_UPDATE_ROLES.includes(r));

/** The kinds of task. Posts and reels use the work log's names, so they count the same. */
export const WORK_UPDATE_KINDS = [
  'INSTAGRAM_POST',
  'INSTAGRAM_REEL',
  'INSTAGRAM_STORY',
  'FACEBOOK_POST',
  'FACEBOOK_REEL',
  'YOUTUBE_VIDEO',
  'YOUTUBE_SHORT',
  'PINTEREST_PIN',
  'LINKEDIN_POST',
  'WHATSAPP_QUOTE_IMAGE',
  'WHATSAPP_BROADCAST',
  'AD_CAMPAIGN',
  'CONTENT_DESIGN',
  'VIDEO_EDITING',
  'PHOTO_SHOOT',
  'WEBSITE_UPDATE',
  'CLIENT_MEETING',
  'OTHER',
] as const;

export const WORK_UPDATE_STATUSES = ['WORKING', 'PAUSED', 'DONE', 'DROPPED'] as const;

export const istDay = (now: Date = new Date()) => {
  const start = getISTMidnightInstant(getISTComponents(now).dateString);
  return { start, end: new Date(start.getTime() + 864e5) };
};

/** Minutes worked so far, counting the spell running now. */
export const minutesOf = (
  u: { worked_minutes: number; status: string; resumed_at: Date | null },
  now: Date = new Date(),
) =>
  u.worked_minutes +
  (u.status === 'WORKING' && u.resumed_at
    ? Math.max(0, Math.round((now.getTime() - u.resumed_at.getTime()) / 60000))
    : 0);

/** A finished update in the work log's shape, so reports and Team Today count it the same way. */
export const asWorkLogEntry = (u: {
  id: number;
  kind: string;
  title: string;
  note: string | null;
  link: string | null;
  count: number;
  finished_at: Date | null;
}): WorkLogEntry => ({
  id: -u.id,
  kind: u.kind,
  note: u.note || '',
  link: u.link,
  count: u.count || 1,
  title: u.title,
  associate_name: null,
  associate_id: null,
  at: u.finished_at || new Date(),
});

/** Finished work updates of these people in [start, end), as work log entries. */
export async function doneUpdatesAsWorkLog(employeeIds: number[], start: Date, end: Date) {
  if (!employeeIds.length) return [] as (WorkLogEntry & { employee_id: number })[];
  const rows = await prisma.workUpdate.findMany({
    where: {
      employee_id: { in: employeeIds },
      status: 'DONE',
      finished_at: { gte: start, lt: end },
    },
    orderBy: { finished_at: 'asc' },
  });
  return rows.map((r) => ({ ...asWorkLogEntry(r), employee_id: r.employee_id }));
}

/** Closes the running spell: adds its minutes. */
export const stopClock = (u: { worked_minutes: number; resumed_at: Date | null }, now: Date) =>
  u.worked_minutes +
  (u.resumed_at ? Math.max(0, Math.round((now.getTime() - u.resumed_at.getTime()) / 60000)) : 0);

/** Pauses whatever this person is working on (one task runs at a time). */
export async function pauseRunning(employeeId: number, now: Date = new Date(), exceptId?: number) {
  const running = await prisma.workUpdate.findMany({
    where: {
      employee_id: employeeId,
      status: 'WORKING',
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
  });
  for (const u of running) {
    await prisma.workUpdate.update({
      where: { id: u.id },
      data: { status: 'PAUSED', worked_minutes: stopClock(u, now), resumed_at: null },
    });
  }
  return running.length;
}

// ── the reminder ────────────────────────────────────────────────

const NUDGE_AFTER_MIN = 90;
const NUDGE_TYPE = 'WORK_UPDATE_NUDGE';

/**
 * Every 15 minutes from 09:30 to 18:30 IST: a digital team member who is
 * checked in, has nothing running and no update for 90 minutes gets one
 * reminder (at most one per 90 minutes). At 19:00 anything still running is
 * paused, so a task left open does not count the night.
 */
export async function workUpdateNudgeJob(now: Date = new Date()) {
  // Minutes since IST midnight (IST is UTC+5:30).
  const m = (now.getUTCHours() * 60 + now.getUTCMinutes() + 330) % 1440;
  const { start, end } = istDay(now);

  if (m >= 19 * 60) {
    const running = await prisma.workUpdate.findMany({ where: { status: 'WORKING' } });
    for (const u of running) {
      await prisma.workUpdate.update({
        where: { id: u.id },
        data: { status: 'PAUSED', worked_minutes: stopClock(u, now), resumed_at: null },
      });
    }
    return { nudged: 0, paused: running.length };
  }
  if (m < 9 * 60 + 30 || m > 18 * 60 + 30) return { nudged: 0, paused: 0 };

  const people = await prisma.employee.findMany({
    where: {
      status: 'ACTIVE',
      roles: { some: { role: { name: { in: WORK_UPDATE_ROLES } } } },
      attendance_logs: { some: { check_in_at: { gte: start, lt: end }, check_out_at: null } },
    },
    select: {
      id: true,
      attendance_logs: {
        where: { check_in_at: { gte: start, lt: end } },
        select: { check_in_at: true },
        orderBy: { check_in_at: 'asc' },
        take: 1,
      },
    },
  });
  const cutoff = new Date(now.getTime() - NUDGE_AFTER_MIN * 60000);
  let nudged = 0;
  for (const e of people) {
    const running = await prisma.workUpdate.count({
      where: { employee_id: e.id, status: 'WORKING' },
    });
    if (running) continue;
    const last = await prisma.workUpdate.findFirst({
      where: { employee_id: e.id, updated_at: { gte: start } },
      orderBy: { updated_at: 'desc' },
      select: { updated_at: true },
    });
    const since = last?.updated_at || e.attendance_logs[0]?.check_in_at;
    if (!since || since > cutoff) continue;
    const recent = await prisma.notification.count({
      where: { employee_id: e.id, type: NUDGE_TYPE, created_at: { gte: cutoff } },
    });
    if (recent) continue;
    await notifyEmployee(e.id, {
      type: NUDGE_TYPE,
      title: 'What are you working on?',
      message:
        'No work update for a while. Tap Start on the task you are doing, so it shows on Team Today.',
      link: '/work-updates',
    });
    nudged++;
  }
  if (nudged) logger.info(`[WorkUpdates] ${nudged} reminder(s).`);
  return { nudged, paused: 0 };
}

/** Today's finished tasks, for the day-end report (stored with it). */
export async function todaysWorkForReport(employeeId: number, now: Date = new Date()) {
  const { start, end } = istDay(now);
  const rows = await prisma.workUpdate.findMany({
    where: { employee_id: employeeId, status: 'DONE', finished_at: { gte: start, lt: end } },
    orderBy: { finished_at: 'asc' },
  });
  return rows.map((r) => ({
    kind: r.kind,
    title: r.title,
    link: r.link,
    count: r.count,
    minutes: r.worked_minutes,
    finished_at: r.finished_at,
  }));
}
