import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { validateRequestBody } from '../middleware/validate';
import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';
import { Permissions } from '../shared';
import { hasEffectivePermission } from '../middleware/authz';
import { BILLING_CYCLES, DIGITAL_KINDS, daysLeft, istToday, nextRenewal } from '../services/digitalAssets';

/** Plans, subscriptions, domains and licences with their renewal dates. Mounted at /api/v1/digital-assets. */
const router = Router();
const p = prisma as any;
router.use(authenticateToken);

const guard =
  (perm: string) => async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!(await hasEffectivePermission(req.user!, perm))) {
      return res.status(403).json({ error: 'Digital assets are for HR, the MD and the Admin.' });
    }
    next();
  };
const canRead = guard(Permissions.ASSETS_READ);
const canManage = guard(Permissions.ASSETS_MANAGE);

const fail = (res: Response, error: unknown, what: string) => {
  logger.error(`Digital asset ${what} error:`, error);
  return res.status(500).json({ error: `Could not ${what}` });
};

const view = (a: any) => ({ ...a, cost: a.cost == null ? null : Number(a.cost), days_left: daysLeft(a.renews_on) });

router.get('/meta', canRead, (_req, res) => res.json({ kinds: DIGITAL_KINDS, cycles: BILLING_CYCLES }));

router.get('/', canRead, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const status = req.query.status === 'CANCELLED' ? 'CANCELLED' : 'ACTIVE';
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const rows = await p.digitalAsset.findMany({
      where: {
        company_id: req.user!.companyId,
        status,
        ...(q ? { OR: [{ name: { contains: q } }, { vendor: { contains: q } }] } : {}),
      },
      include: { owner: { select: { id: true, full_name: true, employee_code: true } } },
      orderBy: [{ renews_on: 'asc' }, { id: 'asc' }],
      take: 500,
    });
    const items = rows.map(view);
    const active = status === 'ACTIVE' ? items : [];
    return res.json({
      items,
      summary: {
        overdue: active.filter((a: any) => a.days_left < 0).length,
        within_7: active.filter((a: any) => a.days_left >= 0 && a.days_left <= 7).length,
        within_30: active.filter((a: any) => a.days_left > 7 && a.days_left <= 30).length,
        yearly_cost: Math.round(
          active.reduce((n: number, a: any) => {
            const months = BILLING_CYCLES.find((c) => c.value === a.billing_cycle)?.months || 0;
            return n + (a.cost && months ? (a.cost * 12) / months : 0);
          }, 0),
        ),
      },
    });
  } catch (error) {
    return fail(res, error, 'load the digital assets');
  }
});

const DateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date');
const Body = z.object({
  name: z.string().trim().min(2).max(150),
  kind: z.enum(DIGITAL_KINDS.map((k) => k.value) as [string, ...string[]]),
  vendor: z.string().trim().max(120).optional().nullable(),
  plan: z.string().trim().max(120).optional().nullable(),
  cost: z.number().nonnegative().optional().nullable(),
  billing_cycle: z.enum(BILLING_CYCLES.map((c) => c.value) as [string, ...string[]]),
  renews_on: DateKey,
  auto_renew: z.boolean().optional(),
  account_note: z.string().trim().max(255).optional().nullable(),
  owner_id: z.number().int().positive().optional().nullable(),
  notes: z.string().trim().max(2000).optional().nullable(),
});
const asDate = (k: string) => new Date(`${k}T00:00:00Z`);

router.post('/', canManage, validateRequestBody(Body), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const b = req.body;
    const row = await p.digitalAsset.create({
      data: {
        company_id: req.user!.companyId,
        created_by_id: req.user!.employeeId,
        name: b.name,
        kind: b.kind,
        vendor: b.vendor || null,
        plan: b.plan || null,
        cost: b.cost ?? null,
        billing_cycle: b.billing_cycle,
        renews_on: asDate(b.renews_on),
        auto_renew: !!b.auto_renew,
        account_note: b.account_note || null,
        owner_id: b.owner_id ?? null,
        notes: b.notes || null,
      },
    });
    return res.status(201).json({ item: view(row) });
  } catch (error) {
    return fail(res, error, 'save the digital asset');
  }
});

router.put('/:id', canManage, validateRequestBody(Body.partial().extend({ status: z.enum(['ACTIVE', 'CANCELLED']).optional() })), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    const own = await p.digitalAsset.findFirst({ where: { id, company_id: req.user!.companyId } });
    if (!own) return res.status(404).json({ error: 'Not found' });
    const b = req.body;
    const row = await p.digitalAsset.update({
      where: { id },
      data: {
        ...(b.name !== undefined ? { name: b.name } : {}),
        ...(b.kind !== undefined ? { kind: b.kind } : {}),
        ...(b.vendor !== undefined ? { vendor: b.vendor || null } : {}),
        ...(b.plan !== undefined ? { plan: b.plan || null } : {}),
        ...(b.cost !== undefined ? { cost: b.cost } : {}),
        ...(b.billing_cycle !== undefined ? { billing_cycle: b.billing_cycle } : {}),
        ...(b.renews_on !== undefined ? { renews_on: asDate(b.renews_on) } : {}),
        ...(b.auto_renew !== undefined ? { auto_renew: b.auto_renew } : {}),
        ...(b.account_note !== undefined ? { account_note: b.account_note || null } : {}),
        ...(b.owner_id !== undefined ? { owner_id: b.owner_id } : {}),
        ...(b.notes !== undefined ? { notes: b.notes || null } : {}),
        ...(b.status !== undefined ? { status: b.status } : {}),
      },
    });
    return res.json({ item: view(row) });
  } catch (error) {
    return fail(res, error, 'change the digital asset');
  }
});

// Renewed: the date moves on by the billing cycle (or to the date given), and the cost may change.
router.post(
  '/:id/renew',
  canManage,
  validateRequestBody(z.object({ renews_on: DateKey.optional(), cost: z.number().nonnegative().optional() })),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const id = Number(req.params.id);
      const own = await p.digitalAsset.findFirst({ where: { id, company_id: req.user!.companyId } });
      if (!own) return res.status(404).json({ error: 'Not found' });
      const next = req.body.renews_on ? asDate(req.body.renews_on) : nextRenewal(own.renews_on, own.billing_cycle, istToday());
      if (!next) {
        return res.status(400).json({ error: 'A one-time item does not renew. Enter the new expiry date.' });
      }
      const row = await p.digitalAsset.update({
        where: { id },
        data: { renews_on: next, last_renewed_at: new Date(), ...(req.body.cost !== undefined ? { cost: req.body.cost } : {}) },
      });
      return res.json({ item: view(row) });
    } catch (error) {
      return fail(res, error, 'renew the digital asset');
    }
  },
);

export default router;
