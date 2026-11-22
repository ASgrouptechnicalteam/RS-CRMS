import { Router, Response } from 'express';
import { z } from 'zod';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { validateRequestBody } from '../middleware/validate';
import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';
import { Roles } from '../shared';
import { notifyEmployee } from '../utils/notifyEmployee';

/**
 * Meetings (owner, 2026-11-21): HR, the MD and managers schedule a meeting and choose who is
 * invited. Everyone invited is notified with the details and answers yes or no; a reminder goes
 * out shortly before it starts (jobs/scheduler.ts). Mounted at /api/v1/meetings.
 */
const router = Router();
const p = prisma as any;
router.use(authenticateToken);

const ORGANISERS: string[] = [
  Roles.MD,
  Roles.ADMIN,
  Roles.HR_MANAGER,
  Roles.TECHNICAL_MANAGER,
  Roles.MARKETING_DIRECTOR,
  Roles.SALES_MANAGER,
];
const canOrganise = (roles: string[]) => roles.some((r) => ORGANISERS.includes(r));

const fail = (res: Response, error: unknown, what: string) => {
  logger.error(`Meeting ${what} error:`, error);
  return res.status(500).json({ error: `Could not ${what}` });
};

const when = (d: Date) =>
  d.toLocaleString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Kolkata',
  });

const Body = z.object({
  title: z.string().trim().min(3, 'Write a title').max(150),
  details: z.string().trim().max(2000).optional().nullable(),
  location: z.string().trim().max(200).optional().nullable(),
  start_at: z.string().min(1),
  end_at: z.string().optional().nullable(),
  invitee_ids: z.array(z.number().int().positive()).max(500).default([]),
  everyone: z.boolean().optional(),
});

// Who can be invited: everyone active in the company (organisers only).
router.get('/people', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!canOrganise(req.user!.roles)) return res.status(403).json({ error: 'Not allowed' });
    const people = await p.employee.findMany({
      where: { company_id: req.user!.companyId, status: 'ACTIVE', deleted_at: null },
      select: {
        id: true,
        full_name: true,
        employee_code: true,
        roles: { select: { role: { select: { name: true } } } },
      },
      orderBy: { full_name: 'asc' },
      take: 1000,
    });
    return res.json({
      people: people.map((x: any) => ({
        id: x.id,
        name: x.full_name || x.employee_code,
        code: x.employee_code,
        roles: x.roles.map((r: any) => r.role.name),
      })),
    });
  } catch (error) {
    return fail(res, error, 'load the people');
  }
});

router.post('/', validateRequestBody(Body), async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!canOrganise(req.user!.roles)) {
      return res.status(403).json({ error: 'Only HR, the MD and managers can schedule meetings.' });
    }
    const start = new Date(req.body.start_at);
    const end = req.body.end_at ? new Date(req.body.end_at) : null;
    if (Number.isNaN(start.getTime())) return res.status(400).json({ error: 'Choose the date and time.' });
    if (start.getTime() < Date.now() - 5 * 60 * 1000) {
      return res.status(400).json({ error: 'The meeting cannot start in the past.' });
    }
    if (end && end.getTime() <= start.getTime()) {
      return res.status(400).json({ error: 'The end time must be after the start.' });
    }
    const people = await p.employee.findMany({
      where: {
        company_id: req.user!.companyId,
        status: 'ACTIVE',
        deleted_at: null,
        ...(req.body.everyone ? {} : { id: { in: req.body.invitee_ids } }),
      },
      select: { id: true },
    });
    const ids: number[] = people
      .map((x: { id: number }) => x.id)
      .filter((id: number) => id !== req.user!.employeeId);
    if (!ids.length) return res.status(400).json({ error: 'Choose at least one person to invite.' });

    const meeting = await p.meeting.create({
      data: {
        company_id: req.user!.companyId,
        created_by_id: req.user!.employeeId,
        title: req.body.title,
        details: req.body.details || null,
        location: req.body.location || null,
        start_at: start,
        end_at: end,
        invites: { create: ids.map((employee_id) => ({ employee_id })) },
      },
    });
    await notifyEmployee(ids, {
      type: 'MEETING_INVITE',
      title: `Meeting: ${meeting.title}`,
      message: `${when(start)}${meeting.location ? `, ${meeting.location}` : ''}. Please say if you can come.`,
      link: '/meetings',
    }).catch((err) => logger.error('Meeting notify failed:', err));
    return res.status(201).json({ meeting, invited: ids.length });
  } catch (error) {
    return fail(res, error, 'schedule the meeting');
  }
});

// Meetings the caller organised or is invited to: upcoming and the last 14 days.
router.get('/mine', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const me = req.user!.employeeId;
    const since = new Date(Date.now() - 14 * 86400000);
    const meetings = await p.meeting.findMany({
      where: {
        company_id: req.user!.companyId,
        start_at: { gte: since },
        OR: [{ created_by_id: me }, { invites: { some: { employee_id: me } } }],
      },
      include: {
        created_by: { select: { id: true, full_name: true, employee_code: true } },
        invites: {
          select: {
            employee_id: true,
            response: true,
            employee: { select: { full_name: true, employee_code: true } },
          },
        },
      },
      orderBy: { start_at: 'asc' },
      take: 200,
    });
    return res.json({
      meetings: meetings.map((m: any) => {
        const mine = m.invites.find((i: any) => i.employee_id === me);
        const organiser = m.created_by_id === me;
        return {
          id: m.id,
          title: m.title,
          details: m.details,
          location: m.location,
          start_at: m.start_at,
          end_at: m.end_at,
          status: m.status,
          organiser,
          organiser_name: m.created_by?.full_name || m.created_by?.employee_code,
          my_response: mine?.response || null,
          counts: {
            invited: m.invites.length,
            yes: m.invites.filter((i: any) => i.response === 'YES').length,
            no: m.invites.filter((i: any) => i.response === 'NO').length,
          },
          // Only the organiser sees who answered what.
          invites: organiser
            ? m.invites.map((i: any) => ({
                name: i.employee?.full_name || i.employee?.employee_code,
                response: i.response,
              }))
            : undefined,
        };
      }),
    });
  } catch (error) {
    return fail(res, error, 'load your meetings');
  }
});

router.post(
  '/:id/respond',
  validateRequestBody(z.object({ response: z.enum(['YES', 'NO']) })),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const id = Number(req.params.id);
      const done = await p.meetingInvite.updateMany({
        where: { meeting_id: id, employee_id: req.user!.employeeId },
        data: { response: req.body.response, responded_at: new Date() },
      });
      if (!done.count) return res.status(404).json({ error: 'You are not invited to this meeting.' });
      return res.json({ message: req.body.response === 'YES' ? 'See you there.' : 'Noted.' });
    } catch (error) {
      return fail(res, error, 'save your answer');
    }
  },
);

router.post('/:id/cancel', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    const meeting = await p.meeting.findFirst({
      where: { id, company_id: req.user!.companyId },
      include: { invites: { select: { employee_id: true } } },
    });
    if (!meeting) return res.status(404).json({ error: 'Meeting not found' });
    if (meeting.created_by_id !== req.user!.employeeId && !req.user!.roles.includes(Roles.ADMIN)) {
      return res.status(403).json({ error: 'Only the person who scheduled it can cancel it.' });
    }
    await p.meeting.update({ where: { id }, data: { status: 'CANCELLED' } });
    await notifyEmployee(
      meeting.invites.map((i: { employee_id: number }) => i.employee_id),
      {
        type: 'MEETING_CANCELLED',
        title: `Meeting cancelled: ${meeting.title}`,
        message: `It was planned for ${when(meeting.start_at)}.`,
        link: '/meetings',
      },
    ).catch((err) => logger.error('Meeting notify failed:', err));
    return res.json({ message: 'Cancelled. Everyone invited was told.' });
  } catch (error) {
    return fail(res, error, 'cancel the meeting');
  }
});

export default router;
