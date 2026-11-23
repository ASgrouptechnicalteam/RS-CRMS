import { Router, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';
import { Roles } from '../shared';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { cpInterestRateLimiter } from '../middleware/rateLimiter';
import { normalizeCpPhone } from '../services/cpLeadImport';
import { getAccessibleCompanyIds } from '../authz/dataScope';

/**
 * The channel partner details form (2026-11-23).
 *
 * POST / is deliberately UNAUTHENTICATED (partners reach it through a link we share, with no account),
 * so it is rate limited, takes a fixed set of fields only, and answers the same whether or not the
 * phone number was sent before (a repeat updates the earlier entry). It only COLLECTS details: no
 * account, lead or notification is created from it. HR (and MD, Admin, Marketing Director) read the
 * entries in the HR hub through GET /.
 */
const router = Router();
const p = prisma as any;

const FormSchema = z.object({
  full_name: z.string().trim().min(2, 'Enter your full name').max(120),
  phone: z.string().trim().min(8, 'Enter your mobile number').max(20),
  email: z.string().trim().toLowerCase().email('Enter a valid email address').max(120),
  projects_handled: z
    .string()
    .trim()
    .min(3, 'Tell us which projects you handle')
    .max(2000, 'Please keep this under 2000 characters'),
  // A hidden field real people never fill: bots do.
  website: z.string().optional(),
});

/** The company a form entry belongs to: set in the environment, else the Radha Real Home company. */
async function formCompanyId(): Promise<number | null> {
  const code = process.env.CP_FORM_COMPANY_CODE;
  const company = code
    ? await p.company.findFirst({ where: { code }, select: { id: true } })
    : ((await p.company.findFirst({
        where: { OR: [{ code: { contains: 'RRH' } }, { code: { contains: 'RADHA' } }] },
        orderBy: { id: 'asc' },
        select: { id: true },
      })) ?? (await p.company.findFirst({ orderBy: { id: 'asc' }, select: { id: true } })));
  return company?.id ?? null;
}

router.post('/', cpInterestRateLimiter, async (req, res: Response) => {
  try {
    const body = FormSchema.safeParse(req.body || {});
    if (!body.success) {
      return res.status(400).json({ error: body.error.issues[0]?.message || 'Check the details.' });
    }
    // A bot filled the hidden field: pretend it worked and store nothing.
    if (body.data.website) return res.status(201).json({ ok: true });

    const phone = normalizeCpPhone(body.data.phone);
    if (!phone) return res.status(400).json({ error: 'Enter a valid 10-digit mobile number.' });

    const company_id = await formCompanyId();
    const existing = await p.cpApplication.findFirst({ where: { company_id, phone } });
    if (existing) {
      await p.cpApplication.update({
        where: { id: existing.id },
        data: {
          full_name: body.data.full_name,
          email: body.data.email,
          projects_handled: body.data.projects_handled,
          submissions: existing.submissions + 1,
          status: 'NEW',
        },
      });
    } else {
      await p.cpApplication.create({
        data: {
          company_id,
          full_name: body.data.full_name,
          phone,
          email: body.data.email,
          projects_handled: body.data.projects_handled,
        },
      });
    }
    return res.status(201).json({ ok: true });
  } catch (e) {
    logger.error({ err: e }, 'Partner details form error');
    return res.status(500).json({ error: 'Could not save your details. Please try again.' });
  }
});

// ---- HR side ---------------------------------------------------------------------------------

const readers: string[] = [Roles.MD, Roles.HR_MANAGER, Roles.ADMIN, Roles.MARKETING_DIRECTOR];
const onlyHr = (req: AuthenticatedRequest, res: Response, next: () => void) =>
  (req.user?.roles || []).some((r) => readers.includes(r))
    ? next()
    : res.status(403).json({ error: 'Only HR, the MD or Admin can see these.' });

router.get('/', authenticateToken, onlyHr, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const companyIds = await getAccessibleCompanyIds(req.user!);
    const status =
      req.query.status === 'REVIEWED' || req.query.status === 'NEW' ? req.query.status : undefined;
    const rows = await p.cpApplication.findMany({
      where: { company_id: { in: companyIds }, ...(status ? { status } : {}) },
      orderBy: [{ status: 'asc' }, { updated_at: 'desc' }],
      take: 500,
    });
    const counts = await p.cpApplication.groupBy({
      by: ['status'],
      where: { company_id: { in: companyIds } },
      _count: { _all: true },
    });
    const n = (s: string) => counts.find((c: any) => c.status === s)?._count._all ?? 0;
    return res.status(200).json({
      applications: rows,
      counts: { new: n('NEW'), reviewed: n('REVIEWED'), total: n('NEW') + n('REVIEWED') },
    });
  } catch (e) {
    logger.error({ err: e }, 'Partner details list error');
    return res.status(500).json({ error: 'Could not load the partner details.' });
  }
});

const EditSchema = z.object({
  status: z.enum(['NEW', 'REVIEWED']).optional(),
  hr_note: z.string().trim().max(500).optional().nullable(),
});
router.patch(
  '/:id',
  authenticateToken,
  onlyHr,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const id = Number(req.params.id);
      const body = EditSchema.safeParse(req.body || {});
      if (!Number.isInteger(id) || id <= 0 || !body.success) {
        return res.status(400).json({ error: 'Check the details.' });
      }
      const companyIds = await getAccessibleCompanyIds(req.user!);
      const row = await p.cpApplication.findFirst({
        where: { id, company_id: { in: companyIds } },
      });
      if (!row) return res.status(404).json({ error: 'Not found' });
      const saved = await p.cpApplication.update({
        where: { id },
        data: {
          ...(body.data.status ? { status: body.data.status } : {}),
          ...(body.data.hr_note !== undefined ? { hr_note: body.data.hr_note || null } : {}),
        },
      });
      return res.status(200).json({ application: saved });
    } catch (e) {
      logger.error({ err: e }, 'Partner details edit error');
      return res.status(500).json({ error: 'Could not save.' });
    }
  },
);

export default router;
