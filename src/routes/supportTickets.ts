import { Router, Response } from 'express';
import { z } from 'zod';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { validateRequestBody } from '../middleware/validate';
import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';
import { Roles } from '../shared';
import { notifyEmployee } from '../utils/notifyEmployee';

/**
 * Queries and problems raised from Help & FAQ (owner, 2026-11-21): about the CRM, the My
 * Property portal or the Sales Portal. They go to the Technical Manager (and Admin), who
 * answers them here. Everyone sees only their own queries.
 */
const router = Router();
const p = prisma as any;
router.use(authenticateToken);

const PORTALS = ['CRM', 'MY_PROPERTY', 'SALES_PORTAL'] as const;
const STATUSES = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] as const;

const canHandle = (roles: string[]) =>
  roles.includes(Roles.TECHNICAL_MANAGER) || roles.includes(Roles.ADMIN);

const fail = (res: Response, error: unknown, what: string) => {
  logger.error(`Support ticket ${what} error:`, error);
  return res.status(500).json({ error: `Could not ${what}` });
};

const CreateSchema = z.object({
  portal: z.enum(PORTALS).default('CRM'),
  subject: z.string().trim().min(3, 'Write a short title').max(150),
  message: z
    .string()
    .trim()
    .min(10, 'Describe the problem or question (at least 10 letters)')
    .max(3000),
});

router.post(
  '/',
  validateRequestBody(CreateSchema),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const ticket = await p.supportTicket.create({
        data: {
          company_id: req.user!.companyId,
          created_by_id: req.user!.employeeId,
          portal: req.body.portal,
          subject: req.body.subject,
          message: req.body.message,
        },
      });
      const handlers = await p.employee.findMany({
        where: {
          company_id: req.user!.companyId,
          status: 'ACTIVE',
          roles: { some: { role: { name: Roles.TECHNICAL_MANAGER } } },
        },
        select: { id: true },
      });
      if (handlers.length) {
        await notifyEmployee(
          handlers.map((h: { id: number }) => h.id),
          {
            type: 'SUPPORT_TICKET',
            title: 'New query raised',
            message: `${req.body.subject} (${req.body.portal.replace(/_/g, ' ').toLowerCase()})`,
            link: '/support-tickets',
          },
        ).catch((err) => logger.error('Support ticket notify failed:', err));
      }
      return res
        .status(201)
        .json({ message: 'Your query was sent to the Technical Manager.', ticket });
    } catch (error) {
      return fail(res, error, 'send the query');
    }
  },
);

// The caller's own queries, newest first.
router.get('/mine', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tickets = await p.supportTicket.findMany({
      where: { created_by_id: req.user!.employeeId },
      orderBy: { created_at: 'desc' },
      take: 100,
    });
    return res.json({ tickets });
  } catch (error) {
    return fail(res, error, 'load your queries');
  }
});

// Every query, for the Technical Manager and Admin. ?status= filters.
router.get('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!canHandle(req.user!.roles)) return res.status(403).json({ error: 'Not allowed' });
    const status = typeof req.query.status === 'string' ? req.query.status : '';
    const tickets = await p.supportTicket.findMany({
      where: {
        company_id: req.user!.companyId,
        ...((STATUSES as readonly string[]).includes(status) ? { status } : {}),
      },
      include: { created_by: { select: { id: true, full_name: true, employee_code: true } } },
      orderBy: [{ created_at: 'desc' }],
      take: 300,
    });
    // Waiting first, then being looked at, then answered; newest first inside each.
    const rank: Record<string, number> = { OPEN: 0, IN_PROGRESS: 1, RESOLVED: 2, CLOSED: 3 };
    tickets.sort((a: any, b: any) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9));
    const open = await p.supportTicket.count({
      where: { company_id: req.user!.companyId, status: { in: ['OPEN', 'IN_PROGRESS'] } },
    });
    return res.json({ tickets, open });
  } catch (error) {
    return fail(res, error, 'load the queries');
  }
});

const UpdateSchema = z.object({
  status: z.enum(STATUSES),
  reply: z.string().trim().max(2000).optional(),
});

router.patch(
  '/:id',
  validateRequestBody(UpdateSchema),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!canHandle(req.user!.roles)) return res.status(403).json({ error: 'Not allowed' });
      const id = Number(req.params.id);
      const ticket = await p.supportTicket.findFirst({
        where: { id, company_id: req.user!.companyId },
      });
      if (!ticket) return res.status(404).json({ error: 'Query not found' });
      if (
        (req.body.status === 'RESOLVED' || req.body.status === 'CLOSED') &&
        !(req.body.reply || ticket.reply)
      ) {
        return res.status(400).json({ error: 'Write the answer before closing the query.' });
      }
      const updated = await p.supportTicket.update({
        where: { id },
        data: {
          status: req.body.status,
          ...(req.body.reply ? { reply: req.body.reply } : {}),
          handled_by_id: req.user!.employeeId,
          resolved_at:
            req.body.status === 'RESOLVED' || req.body.status === 'CLOSED' ? new Date() : null,
        },
      });
      await notifyEmployee(ticket.created_by_id, {
        type: 'SUPPORT_TICKET',
        title: `Your query is ${req.body.status.replace(/_/g, ' ').toLowerCase()}`,
        message: `${ticket.subject}${req.body.reply ? `: ${req.body.reply.slice(0, 120)}` : ''}`,
        link: '/faq',
      }).catch((err) => logger.error('Support ticket notify failed:', err));
      return res.json({ message: 'Saved', ticket: updated });
    } catch (error) {
      return fail(res, error, 'update the query');
    }
  },
);

export default router;
