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
      cp_project_limit: true,
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
        cp_project_limit: true,
      },
      orderBy: { full_name: 'asc' },
    });
    const ids = partners.map((x: any) => x.id);
    const [users, leads, visits, drafts, referrals] = ids.length
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
          p.cpReferral.groupBy({
            by: ['cp_id', 'status'],
            where: { cp_id: { in: ids } },
            _count: { _all: true },
          }),
        ])
      : [[], [], [], [], []];
    const m = (rows: any[], key: string) =>
      new Map<number, number>(rows.map((r) => [r[key], r._count._all]));
    const u = m(users, 'cp_id');
    const l = m(leads, 'cp_id');
    const v = m(visits, 'cp_owner_id');
    const d = m(drafts, 'submitted_by');
    // Leads our office referred to each partner: waiting for acceptance, being worked, booked.
    const refCount = (id: number, status: string) =>
      referrals.find((r: any) => r.cp_id === id && r.status === status)?._count._all ?? 0;
    return res.status(200).json({
      partners: partners.map((x: any) => ({
        id: x.id,
        employee_code: x.employee_code,
        full_name: x.full_name,
        status: x.status,
        telecaller_limit: x.cp_telecaller_limit ?? 3,
        project_limit: x.cp_project_limit ?? null,
        telecallers: u.get(x.id) ?? 0,
        leads: l.get(x.id) ?? 0,
        customers_in_our_crm: v.get(x.id) ?? 0,
        listings_sent: d.get(x.id) ?? 0,
        referred_waiting: refCount(x.id, 'OFFERED'),
        referred_working: refCount(x.id, 'ACCEPTED'),
        referred_booked: refCount(x.id, 'BOOKED'),
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

// How many listings the partner may send. Empty means no limit.
router.patch(
  '/:id/project-limit',
  authenticateToken,
  only,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const body = z
      .object({ limit: z.number().int().min(0).max(1000).nullable() })
      .safeParse(req.body);
    if (!Number.isInteger(id) || id <= 0 || !body.success) {
      return res.status(400).json({ error: 'Enter a number from 0 to 1000, or leave it empty.' });
    }
    if (!(await partnerOf(req, id))) return res.status(404).json({ error: 'Partner not found' });
    await p.employee.update({ where: { id }, data: { cp_project_limit: body.data.limit } });
    return res.status(200).json({ ok: true, limit: body.data.limit });
  }),
);

// Our live projects, with the ones given to this partner marked.
router.get(
  '/:id/projects',
  authenticateToken,
  only,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0)
      return res.status(400).json({ error: 'Invalid ID format' });
    if (!(await partnerOf(req, id))) return res.status(404).json({ error: 'Partner not found' });
    const companyIds = await getAccessibleCompanyIds(req.user!);
    const [projects, given] = await Promise.all([
      p.project.findMany({
        where: {
          company_id: { in: companyIds },
          verification_status: 'VERIFIED',
          status: { notIn: ['CANCELLED', 'ON_HOLD'] },
        },
        select: { id: true, name: true, location: true, city: true, project_type: true },
        orderBy: { name: 'asc' },
        take: 500,
      }),
      p.cpProjectAssignment.findMany({ where: { cp_id: id }, select: { project_id: true } }),
    ]);
    const mine = new Set<number>(given.map((g: any) => g.project_id));
    return res.status(200).json({
      projects: projects.map((x: any) => ({ ...x, assigned: mine.has(x.id) })),
    });
  }),
);

// Replace the list of projects given to this partner.
router.put(
  '/:id/projects',
  authenticateToken,
  only,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const body = z
      .object({ project_ids: z.array(z.number().int().positive()).max(500) })
      .safeParse(req.body);
    if (!Number.isInteger(id) || id <= 0 || !body.success)
      return res.status(400).json({ error: 'Pick the projects again.' });
    if (!(await partnerOf(req, id))) return res.status(404).json({ error: 'Partner not found' });
    const companyIds = await getAccessibleCompanyIds(req.user!);
    const ids = [...new Set(body.data.project_ids)];
    const valid = ids.length
      ? await p.project.findMany({
          where: { id: { in: ids }, company_id: { in: companyIds } },
          select: { id: true },
        })
      : [];
    const okIds: number[] = valid.map((v: any) => v.id);
    await p.$transaction([
      p.cpProjectAssignment.deleteMany({ where: { cp_id: id } }),
      ...(okIds.length
        ? [
            p.cpProjectAssignment.createMany({
              data: okIds.map((project_id) => ({
                cp_id: id,
                project_id,
                assigned_by: req.user!.employeeId,
              })),
            }),
          ]
        : []),
    ]);
    return res.status(200).json({ ok: true, assigned: okIds.length });
  }),
);

// Make one of our own employees a member of this partner's team. They sign in with their CRM employee code
// and password. Done here by the office, so a partner can never look up who our employees are.
router.post(
  '/:id/members/employee',
  authenticateToken,
  only,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const body = z
      .object({
        employee_code: z.string().trim().toUpperCase().min(1).max(40),
        // OWNER = full access like the partner themselves (for the MD, Admin or the tech team to see and demo the area).
        member_role: z.enum(['TELECALLER', 'PM', 'OWNER']),
      })
      .safeParse(req.body);
    if (!Number.isInteger(id) || id <= 0 || !body.success)
      return res.status(400).json({ error: 'Enter the employee code and pick a role.' });
    if (!(await partnerOf(req, id))) return res.status(404).json({ error: 'Partner not found' });
    const companyIds = await getAccessibleCompanyIds(req.user!);
    const emp = await p.employee.findFirst({
      where: {
        employee_code: body.data.employee_code,
        company_id: { in: companyIds },
        status: 'ACTIVE',
      },
      select: {
        id: true,
        full_name: true,
        employee_code: true,
        roles: { select: { role: { select: { name: true } } } },
      },
    });
    if (!emp) return res.status(404).json({ error: 'No active employee has that code.' });
    if (emp.roles.some((r: any) => r.role.name === Roles.CHANNEL_PARTNER_EXTERNAL))
      return res.status(400).json({ error: 'That is a partner, not one of our employees.' });
    const taken = await p.cpUser.findFirst({
      where: { OR: [{ employee_id: emp.id }, { login_id: emp.employee_code }] },
    });
    if (taken)
      return res.status(409).json({ error: 'That employee is already on a partner team.' });
    const made = await p.cpUser.create({
      data: {
        cp_id: id,
        full_name: emp.full_name,
        login_id: emp.employee_code,
        password_hash: '!', // never used: an employee signs in with their CRM password
        member_role: body.data.member_role,
        employee_id: emp.id,
      },
      select: { id: true, full_name: true, login_id: true, member_role: true, employee_id: true },
    });
    await p.auditEvent
      .create({
        data: {
          actor_id: req.user!.employeeId,
          action: 'CP_STAFF_ADDED',
          entity_type: 'EMPLOYEE',
          entity_id: emp.id,
          reason: `${emp.full_name} (${emp.employee_code}) added to partner ${id} as ${body.data.member_role}`,
        },
      })
      .catch(() => undefined);
    return res.status(201).json({ member: made });
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
        select: {
          id: true,
          full_name: true,
          login_id: true,
          is_active: true,
          member_role: true,
          employee_id: true,
        },
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
      partner: {
        ...partner,
        telecaller_limit: partner.cp_telecaller_limit ?? 3,
        project_limit: partner.cp_project_limit ?? null,
      },
      team,
      leads,
      counts: Object.fromEntries(byStatus.map((s: any) => [s.status, s._count._all])),
    });
  }),
);

export default router;
