import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';
import { notifyEmployee } from '../utils/notifyEmployee';

const p = prisma as any;

/** Tells the people invited that a meeting starts within 30 minutes. Each meeting is reminded once. */
export async function meetingReminderJob(now: Date = new Date()) {
  const soon = new Date(now.getTime() + 30 * 60 * 1000);
  const due = await p.meeting.findMany({
    where: { status: 'SCHEDULED', reminded_at: null, start_at: { gt: now, lte: soon } },
    include: { invites: { select: { employee_id: true, response: true } } },
  });
  for (const m of due) {
    const ids = m.invites
      .filter((i: { response: string | null }) => i.response !== 'NO')
      .map((i: { employee_id: number }) => i.employee_id);
    const claimed = await p.meeting.updateMany({
      where: { id: m.id, reminded_at: null },
      data: { reminded_at: now },
    });
    if (!claimed.count || !ids.length) continue;
    const minutes = Math.max(1, Math.round((m.start_at.getTime() - now.getTime()) / 60000));
    await notifyEmployee([...ids, m.created_by_id], {
      type: 'MEETING_REMINDER',
      title: `Starting in ${minutes} minutes: ${m.title}`,
      message: m.location ? `At ${m.location}.` : 'Be ready.',
      link: '/meetings',
    }).catch((err) => logger.error('Meeting reminder failed:', err));
  }
  return { reminded: due.length };
}
