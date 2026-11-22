import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { authenticateToken, AuthenticatedRequest, requireRole } from '../middleware/auth';
import { Roles } from '../shared';
import { getAccessibleCompanyIds } from '../authz/dataScope';

/**
 * Our side of the channel partners (2026-11-22), at /api/v1/cp-admin: the MD and Admin see every
 * partner group read-only (team, leads, counts) and set how many telecallers each partner may have.
 * Our other staff, and the partners themselves, cannot reach this.
 */
const router = Router();
const p = prisma as any;

const only = requireRole([Roles.MD, Roles.ADMIN]);

const wrap =
  (fn: (req: AuthenticatedRequest, res: Response) => Promise<unknown>) =>
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      await fn(req, res);
    } catch (e) {
      next(e);
    }
  };

const partnerOf = async (req: AuthenticatedRequest, id: number) => {
  const companyIds = await getAccessibleCompanyIds(req.user!);
  return p.employee.findFirst({
    where: {
      id,
      company_id: { in: companyIds },
      roles: { some: { role: { name: Roles.CHANNEL_PARTNER_EXTERNAL } } },
    },
    select: {
      id: true,
      employee_code: true,
      full_name: true,
      status: true,
      cp_telecaller_limit: true,
    },
  });
};

router.get(
  '/',
  authenticateToken,
  only,
  wrap(async (req, res) => {
    const companyIds = await getAccessibleCompanyIds(req.user!);
    const partners = await p.employee.findMany({
      where: {
        company_id: { in: companyIds },
        roles: { some: { role: { name: Roles.CHANNEL_PARTNER_EXTERNAL } } },
      },
      select: {
        id: true,
        employee_code: true,
        full_name: true,
        status: true,
        cp_telecaller_limit: true,
      },
      orderBy: { full_name: 'asc' },
    });
    const ids = partners.map((x: any) => x.id);
    const [users, leads, visits, drafts] = ids.length
      ? await Promise.all([
          p.cpUser.groupBy({
            by: ['cp_id'],
            where: { cp_id: { in: ids }, is_active: true },
            _count: { _all: true },
          }),
          p.cpLead.groupBy({
            by: ['cp_id'],
            where: { cp_id: { in: ids } },
            _count: { _all: true },
          }),
          p.lead.groupBy({
            by: ['cp_owner_id'],
            where: { cp_owner_id: { in: ids } },
            _count: { _all: true },
          }),
          p.draftSubmission.groupBy({
            by: ['submitted_by'],
            where: { submitted_by: { in: ids } },
            _count: { _all: true },
          }),
        ])
      : [[], [], [], []];
    const m = (rows: any[], key: string) =>
      new Map<number, number>(rows.map((r) => [r[key], r._count._all]));
    const u = m(users, 'cp_id');
    const l = m(leads, 'cp_id');
    const v = m(visits, 'cp_owner_id');
    const d = m(drafts, 'submitted_by');
    return res.status(200).json({
      partners: partners.map((x: any) => ({
        id: x.id,
        employee_code: x.employee_code,
        full_name: x.full_name,
        status: x.status,
        telecaller_limit: x.cp_telecaller_limit ?? 3,
        telecallers: u.get(x.id) ?? 0,
        leads: l.get(x.id) ?? 0,
        customers_in_our_crm: v.get(x.id) ?? 0,
        listings_sent: d.get(x.id) ?? 0,
      })),
    });
  }),
);

router.patch(
  '/:id/limit',
  authenticateToken,
  only,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const body = z.object({ limit: z.number().int().min(0).max(50) }).safeParse(req.body);
    if (!Number.isInteger(id) || id <= 0 || !body.success) {
      return res.status(400).json({ error: 'Enter a number from 0 to 50.' });
    }
    if (!(await partnerOf(req, id))) return res.status(404).json({ error: 'Partner not found' });
    await p.employee.update({ where: { id }, data: { cp_telecaller_limit: body.data.limit } });
    return res.status(200).json({ ok: true, limit: body.data.limit });
  }),
);

router.get(
  '/:id',
  authenticateToken,
  only,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0)
      return res.status(400).json({ error: 'Invalid ID format' });
    const partner = await partnerOf(req, id);
    if (!partner) return res.status(404).json({ error: 'Partner not found' });
    const [team, leads, byStatus] = await Promise.all([
      p.cpUser.findMany({
        where: { cp_id: id },
        select: { id: true, full_name: true, login_id: true, is_active: true },
        orderBy: { id: 'asc' },
      }),
      p.cpLead.findMany({
        where: { cp_id: id },
        orderBy: { id: 'desc' },
        take: 200,
        select: {
          id: true,
          customer_name: true,
          phone: true,
          status: true,
          assigned_to_id: true,
          last_called_at: true,
          lead_id: true,
          created_at: true,
        },
      }),
      p.cpLead.groupBy({ by: ['status'], where: { cp_id: id }, _count: { _all: true } }),
    ]);
    return res.status(200).json({
      partner: { ...partner, telecaller_limit: partner.cp_telecaller_limit ?? 3 },
      team,
      leads,
      counts: Object.fromEntries(byStatus.map((s: any) => [s.status, s._count._all])),
    });
  }),
);

export default router;
