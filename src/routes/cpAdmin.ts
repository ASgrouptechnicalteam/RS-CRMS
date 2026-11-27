import { Router, Response, NextFunction, RequestHandler } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { authenticateToken, AuthenticatedRequest, requireRole } from '../middleware/auth';
import { Roles } from '../shared';
import { getAccessibleCompanyIds, visibleEmployees } from '../authz/dataScope';

/**
 * Our side of the channel partners (2026-11-22), at /api/v1/cp-admin: the MD and Admin see every
 * partner group read-only (team, leads, counts) and set how many telecallers each partner may have.
 * Our other staff, and the partners themselves, cannot reach this.
 */
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

/**
 * The routes are built twice: for our staff at /cp-admin (MD and Admin), and for the "super admin" partner at
 * /cp/super (see routes/cpSuper.ts), which signs in with a partner login. `staff` marks the few things only our
 * own staff may do.
 */
export const buildCpAdminRouter = (mw: RequestHandler[], staff: boolean) => {
  const router = Router();

  router.get(
    '/',
    ...mw,
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
          cp_is_super: true,
          cp_last_seen_at: true,
        },
        orderBy: { full_name: 'asc' },
      });
      const ids = partners.map((x: any) => x.id);
      const weekAgo = new Date(Date.now() - 7 * 86400e3);
      const [users, leads, visits, drafts, referrals, calls7, newLeads7, listings7, lastWork] =
        ids.length
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
              // This week: calls made, customers added, listings sent. And the last time they did any work.
              p.cpLeadActivity.groupBy({
                by: ['cp_id'],
                where: { cp_id: { in: ids }, kind: 'CALL', created_at: { gte: weekAgo } },
                _count: { _all: true },
              }),
              p.cpLead.groupBy({
                by: ['cp_id'],
                where: { cp_id: { in: ids }, created_at: { gte: weekAgo } },
                _count: { _all: true },
              }),
              p.draftSubmission.groupBy({
                by: ['submitted_by'],
                where: { submitted_by: { in: ids }, created_at: { gte: weekAgo } },
                _count: { _all: true },
              }),
              p.cpLeadActivity.groupBy({
                by: ['cp_id'],
                where: { cp_id: { in: ids } },
                _max: { created_at: true },
              }),
            ])
          : [[], [], [], [], [], [], [], [], []];
      const m = (rows: any[], key: string) =>
        new Map<number, number>(rows.map((r) => [r[key], r._count._all]));
      const u = m(users, 'cp_id');
      const l = m(leads, 'cp_id');
      const v = m(visits, 'cp_owner_id');
      const d = m(drafts, 'submitted_by');
      const c7 = m(calls7, 'cp_id');
      const n7 = m(newLeads7, 'cp_id');
      const s7 = m(listings7, 'submitted_by');
      const lastBy = new Map<number, Date>(
        lastWork
          .filter((r: any) => r._max.created_at)
          .map((r: any) => [r.cp_id, r._max.created_at]),
      );
      // Leads our office referred to each partner: waiting for acceptance, being worked, booked.
      const refCount = (id: number, status: string) =>
        referrals.find((r: any) => r.cp_id === id && r.status === status)?._count._all ?? 0;
      const rows = partners.map((x: any) => {
        const work = (c7.get(x.id) ?? 0) + (n7.get(x.id) ?? 0) + (s7.get(x.id) ?? 0);
        const seen = [x.cp_last_seen_at, lastBy.get(x.id)]
          .filter(Boolean)
          .map((t: any) => new Date(t).getTime());
        return {
          id: x.id,
          employee_code: x.employee_code,
          full_name: x.full_name,
          status: x.status,
          is_super: !!x.cp_is_super,
          // "Active" means real work this week (a call, a customer added or a listing sent), not just signing in.
          active_7d: work > 0,
          calls_7d: c7.get(x.id) ?? 0,
          new_leads_7d: n7.get(x.id) ?? 0,
          listings_7d: s7.get(x.id) ?? 0,
          last_active: seen.length ? new Date(Math.max(...seen)).toISOString() : null,
          has_signed_in: !!x.cp_last_seen_at || lastBy.has(x.id),
          telecaller_limit: x.cp_telecaller_limit ?? 3,
          project_limit: x.cp_project_limit ?? null,
          telecallers: u.get(x.id) ?? 0,
          leads: l.get(x.id) ?? 0,
          customers_in_our_crm: v.get(x.id) ?? 0,
          listings_sent: d.get(x.id) ?? 0,
          referred_waiting: refCount(x.id, 'OFFERED'),
          referred_working: refCount(x.id, 'ACCEPTED'),
          referred_booked: refCount(x.id, 'BOOKED'),
        };
      });
      return res.status(200).json({
        summary: {
          total: rows.length,
          active_7d: rows.filter((r: any) => r.status === 'ACTIVE' && r.active_7d).length,
          never_signed_in: rows.filter((r: any) => !r.has_signed_in).length,
          switched_off: rows.filter((r: any) => r.status !== 'ACTIVE').length,
        },
        partners: rows,
      });
    }),
  );

  router.patch(
    '/:id/limit',
    ...mw,
    wrap(async (req, res) => {
      const id = Number(req.params.id);
      const body = z.object({ limit: z.number().int().min(0).max(50) }).safeParse(req.body);
      if (!Number.isInteger(id) || id <= 0 || !body.success) {
        return res.status(400).json({ error: 'Enter a number from 0 to 50.' });
      }
      if (!(await partnerOf(req, id)))
        return res.status(404).json({ error: 'Channel partner not found' });
      await p.employee.update({ where: { id }, data: { cp_telecaller_limit: body.data.limit } });
      return res.status(200).json({ ok: true, limit: body.data.limit });
    }),
  );

  // How many listings the partner may send. Empty means no limit.
  router.patch(
    '/:id/project-limit',
    ...mw,
    wrap(async (req, res) => {
      const id = Number(req.params.id);
      const body = z
        .object({ limit: z.number().int().min(0).max(1000).nullable() })
        .safeParse(req.body);
      if (!Number.isInteger(id) || id <= 0 || !body.success) {
        return res.status(400).json({ error: 'Enter a number from 0 to 1000, or leave it empty.' });
      }
      if (!(await partnerOf(req, id)))
        return res.status(404).json({ error: 'Channel partner not found' });
      await p.employee.update({ where: { id }, data: { cp_project_limit: body.data.limit } });
      return res.status(200).json({ ok: true, limit: body.data.limit });
    }),
  );

  // Our live projects, with the ones given to this partner marked.
  router.get(
    '/:id/projects',
    ...mw,
    wrap(async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0)
        return res.status(400).json({ error: 'Invalid ID format' });
      if (!(await partnerOf(req, id)))
        return res.status(404).json({ error: 'Channel partner not found' });
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
    ...mw,
    wrap(async (req, res) => {
      const id = Number(req.params.id);
      const body = z
        .object({ project_ids: z.array(z.number().int().positive()).max(500) })
        .safeParse(req.body);
      if (!Number.isInteger(id) || id <= 0 || !body.success)
        return res.status(400).json({ error: 'Pick the projects again.' });
      if (!(await partnerOf(req, id)))
        return res.status(404).json({ error: 'Channel partner not found' });
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

  // The employees who can be added to a partner team, for the pick-list: active, not a partner, not already on
  // a partner team. Only name, code and job title are returned.
  router.get(
    '/:id/employee-options',
    ...mw,
    wrap(async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0)
        return res.status(400).json({ error: 'Invalid ID format' });
      if (!(await partnerOf(req, id)))
        return res.status(404).json({ error: 'Channel partner not found' });
      const companyIds = await getAccessibleCompanyIds(req.user!);
      const q = String(req.query.q || '').trim();
      const employees = await p.employee.findMany({
        where: {
          ...visibleEmployees,
          company_id: { in: companyIds },
          status: 'ACTIVE',
          roles: { none: { role: { name: Roles.CHANNEL_PARTNER_EXTERNAL } } },
          ...(q
            ? { OR: [{ full_name: { contains: q } }, { employee_code: { contains: q } }] }
            : {}),
        },
        select: { id: true, employee_code: true, full_name: true, job_title: true },
        orderBy: { full_name: 'asc' },
        take: 500,
      });
      const taken = new Set<number>(
        (
          await p.cpUser.findMany({
            where: { employee_id: { in: employees.map((e: any) => e.id) } },
            select: { employee_id: true },
          })
        ).map((x: any) => x.employee_id),
      );
      return res.status(200).json({
        employees: employees
          .filter((e: any) => !taken.has(e.id))
          .map((e: any) => ({
            id: e.id,
            employee_code: e.employee_code,
            full_name: e.full_name,
            job_title: e.job_title ?? null,
          })),
      });
    }),
  );

  // Make one of our own employees a member of this partner's team. They sign in with their CRM employee code
  // and password. Done here by the office, so a partner can never look up who our employees are.
  router.post(
    '/:id/members/employee',
    ...mw,
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
      if (!(await partnerOf(req, id)))
        return res.status(404).json({ error: 'Channel partner not found' });
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
        return res
          .status(400)
          .json({ error: 'That is a channel partner, not one of our employees.' });
      const taken = await p.cpUser.findFirst({
        where: { OR: [{ employee_id: emp.id }, { login_id: emp.employee_code }] },
      });
      if (taken)
        return res
          .status(409)
          .json({ error: 'That employee is already on a channel partner team.' });
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
            reason: `${emp.full_name} (${emp.employee_code}) added to channel partner ${id} as ${body.data.member_role}`,
          },
        })
        .catch(() => undefined);
      return res.status(201).json({ member: made });
    }),
  );

  router.get(
    '/:id',
    ...mw,
    wrap(async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0)
        return res.status(400).json({ error: 'Invalid ID format' });
      const partner = await partnerOf(req, id);
      if (!partner) return res.status(404).json({ error: 'Channel partner not found' });
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

  // Switch a partner's access off or on. Off: they and their team cannot sign in, and anyone signed in is signed out
  // at once. Nothing is deleted: customers, leads and history stay, and switching back on restores everything.
  router.patch(
    '/:id/access',
    ...mw,
    wrap(async (req, res) => {
      const id = Number(req.params.id);
      const body = z.object({ active: z.boolean() }).safeParse(req.body);
      if (!Number.isInteger(id) || id <= 0 || !body.success)
        return res.status(400).json({ error: 'Say whether access should be on or off.' });
      if (id === req.user!.employeeId)
        return res.status(400).json({ error: 'You cannot switch off your own account here.' });
      const partner = await partnerOf(req, id);
      if (!partner) return res.status(404).json({ error: 'Channel partner not found' });
      const next = body.data.active ? 'ACTIVE' : 'INACTIVE';
      if (partner.status !== next) {
        await p.employee.update({
          where: { id },
          data: { status: next, token_version: { increment: 1 } },
        });
        await p.auditEvent
          .create({
            data: {
              actor_id: req.user!.employeeId,
              action: body.data.active ? 'CP_ACCESS_ON' : 'CP_ACCESS_OFF',
              entity_type: 'EMPLOYEE',
              entity_id: id,
              reason: `Channel partner area access ${body.data.active ? 'switched on' : 'switched off'} for ${partner.full_name} (${partner.employee_code})`,
            },
          })
          .catch(() => undefined);
      }
      return res.status(200).json({ ok: true, status: next });
    }),
  );

  // Mark a partner account as a "super admin" partner: its owner and its Full access members can see every other
  // partner as they see themselves (read only) and manage partners. Only our own staff can set this.
  if (staff) {
    router.patch(
      '/:id/super',
      ...mw,
      wrap(async (req, res) => {
        const id = Number(req.params.id);
        const body = z.object({ on: z.boolean() }).safeParse(req.body);
        if (!Number.isInteger(id) || id <= 0 || !body.success)
          return res.status(400).json({ error: 'Say whether to turn it on or off.' });
        const partner = await partnerOf(req, id);
        if (!partner) return res.status(404).json({ error: 'Channel partner not found' });
        await p.employee.update({ where: { id }, data: { cp_is_super: body.data.on } });
        await p.auditEvent
          .create({
            data: {
              actor_id: req.user!.employeeId,
              action: body.data.on ? 'CP_SUPER_ON' : 'CP_SUPER_OFF',
              entity_type: 'EMPLOYEE',
              entity_id: id,
              reason: `Super admin channel partner ${body.data.on ? 'given to' : 'taken from'} ${partner.full_name} (${partner.employee_code})`,
            },
          })
          .catch(() => undefined);
        return res.status(200).json({ ok: true, is_super: body.data.on });
      }),
    );
  }

  return router;
};

export default buildCpAdminRouter([authenticateToken, only], true);
