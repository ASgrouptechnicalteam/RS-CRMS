import { Router, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';
import { Permissions } from '../shared';
import { requireCp, requireOwner, asUser, CpRequest } from './cp';
import { generateNextLeadCode } from '../services/lead/shared';
import { bookVisit } from '../services/siteVisit/booking';
import { readCpLeadRows, normalizeCpPhone, CP_LEAD_IMPORT_MAX } from '../services/cpLeadImport';

/**
 * The external partner's work area (2026-11-22), mounted at /api/v1/cp next to the sign-in routes.
 * One partner = one group. The group is ALWAYS taken from the signed token (req.cp.id), never from the
 * request, and every query below filters by it. A partner's telecaller (req.cp.user) additionally sees
 * only the leads assigned to them or added by them. Nothing here touches our own lead queries: the
 * partner's leads live in CpLead, and only when a site visit is booked is a normal Lead created in
 * our CRM (with cp_owner_id) so our project manager can run the visit.
 */
const router = Router();
const p = prisma as any;

const handle =
  (fn: (req: CpRequest, res: Response) => Promise<unknown>) =>
  async (req: CpRequest, res: Response, next: NextFunction) => {
    try {
      await fn(req, res);
    } catch (e: any) {
      if (e && typeof e.status === 'number' && e.message) {
        return res.status(e.status).json({ error: e.message });
      }
      logger.error({ err: e }, 'Partner area error');
      next(e);
    }
  };
const fail = (status: number, message: string) => ({ status, message });
const idOf = (raw: unknown) => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw fail(400, 'Invalid ID format');
  return n;
};
const actorName = (req: CpRequest) => req.cp!.user?.full_name || req.cp!.full_name || 'Partner';
const DEFAULT_TELECALLER_LIMIT = 3;

// ── team ──────────────────────────────────────────────────────

const limitOf = async (cpId: number) => {
  const e = await p.employee.findUnique({
    where: { id: cpId },
    select: { cp_telecaller_limit: true },
  });
  return e?.cp_telecaller_limit ?? DEFAULT_TELECALLER_LIMIT;
};

router.get(
  '/team',
  requireCp,
  requireOwner,
  handle(async (req, res) => {
    const cpId = req.cp!.id;
    const [users, counts, limit] = await Promise.all([
      p.cpUser.findMany({
        where: { cp_id: cpId },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          full_name: true,
          login_id: true,
          is_active: true,
          created_at: true,
          member_role: true,
          employee_id: true,
        },
      }),
      p.cpLead.groupBy({
        by: ['assigned_to_id'],
        where: { cp_id: cpId, assigned_to_id: { not: null } },
        _count: { _all: true },
      }),
      limitOf(cpId),
    ]);
    const byUser = new Map<number, number>(
      counts.map((c: any) => [c.assigned_to_id, c._count._all]),
    );
    const callRows = await p.cpLeadActivity.groupBy({
      by: ['actor_user_id'],
      where: {
        cp_id: cpId,
        kind: 'CALL',
        actor_user_id: { not: null },
        created_at: { gte: new Date(Date.now() - 7 * 86400e3) },
      },
      _count: { _all: true },
    });
    const calls7 = new Map<number, number>(
      callRows.map((c: any) => [c.actor_user_id, c._count._all]),
    );
    return res.status(200).json({
      limit,
      used: users.filter((u: any) => u.is_active).length,
      telecallers: users.map((u: any) => ({
        ...u,
        leads: byUser.get(u.id) ?? 0,
        calls_7d: calls7.get(u.id) ?? 0,
      })),
    });
  }),
);

const NewTelecallerSchema = z.object({
  full_name: z.string().trim().min(2).max(120),
  phone: z.string().trim().min(8).max(20),
  password: z.string().min(8, 'The password needs at least 8 characters').max(100),
  // TELECALLER (default) works leads; PM sends listings for the partner.
  member_role: z.enum(['TELECALLER', 'PM']).optional(),
});

router.post(
  '/team',
  requireCp,
  requireOwner,
  handle(async (req, res) => {
    const body = NewTelecallerSchema.safeParse(req.body);
    if (!body.success) throw fail(400, body.error.issues[0]?.message || 'Check the details.');
    const phone = normalizeCpPhone(body.data.phone);
    if (!phone) throw fail(400, 'Enter a valid 10-digit mobile number.');
    const cpId = req.cp!.id;
    const [limit, used] = await Promise.all([
      limitOf(cpId),
      p.cpUser.count({ where: { cp_id: cpId, is_active: true } }),
    ]);
    if (used >= limit) {
      throw fail(409, `Your team can have ${limit} members. Ask the office to raise the limit.`);
    }
    if (await p.cpUser.findUnique({ where: { login_id: phone } })) {
      throw fail(409, 'That phone number already has a login.');
    }
    const made = await p.cpUser.create({
      data: {
        cp_id: cpId,
        full_name: body.data.full_name,
        login_id: phone,
        password_hash: await bcrypt.hash(body.data.password, 12),
        member_role: body.data.member_role ?? 'TELECALLER',
      },
      select: { id: true, full_name: true, login_id: true, is_active: true, member_role: true },
    });
    return res.status(201).json({ telecaller: made });
  }),
);

const EditTelecallerSchema = z.object({
  is_active: z.boolean().optional(),
  password: z.string().min(8).max(100).optional(),
  full_name: z.string().trim().min(2).max(120).optional(),
});

router.patch(
  '/team/:id',
  requireCp,
  requireOwner,
  handle(async (req, res) => {
    const id = idOf(req.params.id);
    const body = EditTelecallerSchema.safeParse(req.body);
    if (!body.success) throw fail(400, body.error.issues[0]?.message || 'Check the details.');
    const cpId = req.cp!.id;
    const u = await p.cpUser.findFirst({ where: { id, cp_id: cpId } });
    if (!u) throw fail(404, 'Telecaller not found');
    const data: Record<string, unknown> = {};
    if (body.data.full_name) data.full_name = body.data.full_name;
    if (body.data.password) {
      data.password_hash = await bcrypt.hash(body.data.password, 12);
      data.token_version = u.token_version + 1;
    }
    if (body.data.is_active !== undefined && body.data.is_active !== u.is_active) {
      if (body.data.is_active) {
        const [limit, used] = await Promise.all([
          limitOf(cpId),
          p.cpUser.count({ where: { cp_id: cpId, is_active: true } }),
        ]);
        if (used >= limit)
          throw fail(409, `Your team can have ${limit} members. Switch another off first.`);
      } else {
        data.token_version = (data.token_version as number | undefined) ?? u.token_version + 1;
        // Their open leads go back to the partner.
        await p.cpLead.updateMany({
          where: { cp_id: cpId, assigned_to_id: id },
          data: { assigned_to_id: null },
        });
      }
      data.is_active = body.data.is_active;
    }
    const saved = await p.cpUser.update({
      where: { id },
      data,
      select: { id: true, full_name: true, login_id: true, is_active: true },
    });
    return res.status(200).json({ telecaller: saved });
  }),
);

// ── leads ─────────────────────────────────────────────────────

/** A PM works for the whole partner group (visits, booking), like the partner; a telecaller only sees their own. */
const isGroupWide = (req: CpRequest) => !req.cp!.user || req.cp!.user.member_role === 'PM';

/** The leads this person may see: the partner and their PM see the group; a telecaller sees theirs. */
const leadScope = (req: CpRequest) => {
  const user = req.cp!.user;
  return user && !isGroupWide(req)
    ? {
        cp_id: req.cp!.id,
        OR: [{ assigned_to_id: user.id }, { assigned_to_id: null, created_by_id: user.id }],
      }
    : { cp_id: req.cp!.id };
};

const LEAD_STATUSES = ['NEW', 'CONTACTED', 'INTERESTED', 'NOT_INTERESTED', 'DROPPED'] as const;
const OPEN_STATUSES = ['NEW', 'CONTACTED', 'INTERESTED', 'VISIT_BOOKED'];

const leadView = (l: any, names: Map<number, string>) => ({
  id: l.id,
  customer_name: l.customer_name,
  phone: l.phone,
  email: l.email,
  status: l.status,
  notes: l.notes,
  source: l.source,
  assigned_to_id: l.assigned_to_id,
  assigned_to_name: l.assigned_to_id ? names.get(l.assigned_to_id) || null : null,
  next_follow_up_at: l.next_follow_up_at,
  last_called_at: l.last_called_at,
  has_visit: !!l.lead_id,
  alt_phone: l.alt_phone ?? null,
  budget_min: l.budget_min ?? null,
  budget_max: l.budget_max ?? null,
  preferred_locations: l.preferred_locations ?? null,
  property_type: l.property_type ?? null,
  created_at: l.created_at,
});

const namesOf = async (cpId: number) => {
  const users = await p.cpUser.findMany({
    where: { cp_id: cpId },
    select: { id: true, full_name: true },
  });
  return new Map<number, string>(users.map((u: any) => [u.id, u.full_name]));
};

router.get(
  '/leads',
  requireCp,
  handle(async (req, res) => {
    const status = String(req.query.status || '');
    const q = String(req.query.q || '').trim();
    const assigned = String(req.query.assigned_to || '');
    const scope = leadScope(req) as any;
    const where: any = { ...scope };
    const and: any[] = [];
    if (status) where.status = status;
    if (q) {
      and.push({
        OR: [
          { customer_name: { contains: q } },
          { phone: { contains: q.replace(/\D/g, '') || q } },
        ],
      });
    }
    if (!req.cp!.user && assigned) {
      where.assigned_to_id = assigned === 'none' ? null : Number(assigned) || -1;
    }
    if (and.length) where.AND = and;
    const [rows, byStatus, names] = await Promise.all([
      p.cpLead.findMany({
        where,
        orderBy: [{ next_follow_up_at: 'asc' }, { id: 'desc' }],
        take: 300,
      }),
      p.cpLead.groupBy({ by: ['status'], where: scope, _count: { _all: true } }),
      namesOf(req.cp!.id),
    ]);
    return res.status(200).json({
      leads: rows.map((l: any) => leadView(l, names)),
      counts: Object.fromEntries(byStatus.map((s: any) => [s.status, s._count._all])),
    });
  }),
);

const NewLeadSchema = z.object({
  customer_name: z.string().trim().min(2).max(120),
  phone: z.string().trim().min(8).max(20),
  email: z.string().trim().max(120).optional().nullable(),
  notes: z.string().trim().max(2000).optional().nullable(),
  assign_to_id: z.number().int().positive().optional().nullable(),
});

/** The telecaller id to assign to; only the partner may choose, and only one of their own active telecallers. */
const assignee = async (req: CpRequest, wanted: number | null | undefined) => {
  if (req.cp!.user) return req.cp!.user.id;
  if (!wanted) return null;
  const u = await p.cpUser.findFirst({
    where: { id: wanted, cp_id: req.cp!.id, is_active: true, member_role: 'TELECALLER' },
  });
  if (!u) throw fail(400, 'Pick one of your own active telecallers.');
  return u.id;
};

router.post(
  '/leads',
  requireCp,
  handle(async (req, res) => {
    const body = NewLeadSchema.safeParse(req.body);
    if (!body.success) throw fail(400, body.error.issues[0]?.message || 'Check the details.');
    const phone = normalizeCpPhone(body.data.phone);
    if (!phone) throw fail(400, 'Enter a valid 10-digit mobile number.');
    const cpId = req.cp!.id;
    const dup = await p.cpLead.findUnique({ where: { cp_id_phone: { cp_id: cpId, phone } } });
    if (dup) throw fail(409, 'You already have a lead with this phone number.');
    const toId = await assignee(req, body.data.assign_to_id);
    const lead = await p.cpLead.create({
      data: {
        cp_id: cpId,
        assigned_to_id: toId,
        created_by_id: req.cp!.user?.id ?? null,
        customer_name: body.data.customer_name,
        phone,
        email: body.data.email || null,
        notes: body.data.notes || null,
      },
    });
    await p.cpLeadActivity.create({
      data: {
        cp_lead_id: lead.id,
        cp_id: cpId,
        actor_user_id: req.cp!.user?.id ?? null,
        actor_name: actorName(req),
        kind: 'NOTE',
        notes: 'Lead added.',
      },
    });
    return res.status(201).json({ lead: leadView(lead, await namesOf(cpId)) });
  }),
);

router.post(
  '/leads/import',
  requireCp,
  handle(async (req, res) => {
    const rows = Array.isArray(req.body?.rows) ? (req.body.rows as Record<string, unknown>[]) : [];
    if (!rows.length) throw fail(400, 'The file has no rows.');
    if (rows.length > CP_LEAD_IMPORT_MAX)
      throw fail(400, `Import up to ${CP_LEAD_IMPORT_MAX} rows at a time.`);
    const cpId = req.cp!.id;
    const toId = await assignee(req, Number(req.body?.assign_to_id) || null);
    const parsed = readCpLeadRows(rows);
    const phones = parsed.filter((r) => r.lead).map((r) => r.lead!.phone);
    const have = phones.length
      ? await p.cpLead.findMany({
          where: { cp_id: cpId, phone: { in: phones } },
          select: { phone: true },
        })
      : [];
    const seen = new Set<string>(have.map((h: any) => h.phone));
    const results = parsed.map((r) => {
      if (!r.lead) return { row: r.row, status: 'ERROR' as const, message: r.error! };
      if (seen.has(r.lead.phone))
        return { row: r.row, status: 'SKIP' as const, message: 'Already in your leads.' };
      seen.add(r.lead.phone);
      return { row: r.row, status: 'NEW' as const, lead: r.lead };
    });
    const fresh = results.filter((r) => r.status === 'NEW');
    const errors = results.filter((r) => r.status === 'ERROR').length;
    const summary = {
      new: fresh.length,
      skipped: results.filter((r) => r.status === 'SKIP').length,
      errors,
    };
    const publicRows = results.map(({ lead: _l, ...rest }: any) => rest);
    if (req.body?.dry_run !== false || errors || !fresh.length) {
      return res.status(200).json({ saved: false, summary, rows: publicRows });
    }
    await p.cpLead.createMany({
      data: fresh.map((r: any) => ({
        cp_id: cpId,
        assigned_to_id: toId,
        created_by_id: req.cp!.user?.id ?? null,
        customer_name: r.lead.customer_name,
        phone: r.lead.phone,
        email: r.lead.email,
        notes: r.lead.notes,
        source: 'CP_IMPORT',
      })),
    });
    return res.status(201).json({ saved: true, summary, rows: publicRows });
  }),
);

/** One lead of this person's scope, or 404 (a lead of another group looks exactly like a missing one). */
const ownLead = async (req: CpRequest, id: number) => {
  const l = await p.cpLead.findFirst({ where: { id, ...(leadScope(req) as any) } });
  if (!l) throw fail(404, 'Lead not found');
  return l;
};

router.get(
  '/leads/:id',
  requireCp,
  handle(async (req, res) => {
    const l = await ownLead(req, idOf(req.params.id));
    const [activities, names] = await Promise.all([
      p.cpLeadActivity.findMany({
        where: { cp_lead_id: l.id, cp_id: req.cp!.id },
        orderBy: { id: 'desc' },
        take: 100,
        select: {
          id: true,
          kind: true,
          outcome: true,
          notes: true,
          actor_name: true,
          created_at: true,
        },
      }),
      namesOf(req.cp!.id),
    ]);
    const tasks = await p.cpTask.findMany({
      where: { cp_lead_id: l.id, cp_id: req.cp!.id },
      orderBy: [{ done_at: 'asc' }, { due_at: 'asc' }],
      take: 50,
      select: { id: true, title: true, due_at: true, done_at: true },
    });
    return res.status(200).json({ lead: leadView(l, names), activities, tasks });
  }),
);

const CALL_OUTCOMES = {
  CONNECTED_INTERESTED: 'INTERESTED',
  CONNECTED_NOT_INTERESTED: 'NOT_INTERESTED',
  CALL_BACK: 'CONTACTED',
  NO_ANSWER: 'CONTACTED',
  BUSY: 'CONTACTED',
  WRONG_NUMBER: 'DROPPED',
} as const;
const CallSchema = z.object({
  outcome: z.enum(
    Object.keys(CALL_OUTCOMES) as [keyof typeof CALL_OUTCOMES, ...(keyof typeof CALL_OUTCOMES)[]],
  ),
  notes: z.string().trim().max(1000).optional().nullable(),
  follow_up_at: z.string().optional().nullable(),
});

const closedForWork = (l: any) => l.status === 'DROPPED' && !!l.lead_id;

router.post(
  '/leads/:id/calls',
  requireCp,
  handle(async (req, res) => {
    const body = CallSchema.safeParse(req.body);
    if (!body.success) throw fail(400, 'Pick the result of the call.');
    const l = await ownLead(req, idOf(req.params.id));
    if (closedForWork(l)) throw fail(409, 'This lead is closed.');
    let followUp: Date | null = null;
    if (body.data.follow_up_at) {
      followUp = new Date(body.data.follow_up_at);
      if (Number.isNaN(followUp.getTime())) throw fail(400, 'The follow-up date is not valid.');
    }
    if (body.data.outcome === 'CALL_BACK' && !followUp) throw fail(400, 'Say when to call back.');
    const next = CALL_OUTCOMES[body.data.outcome];
    // A visit that is booked stays "visit booked" unless the customer drops out.
    const status =
      l.status === 'VISIT_BOOKED' && next !== 'DROPPED' && next !== 'NOT_INTERESTED'
        ? 'VISIT_BOOKED'
        : next;
    await p.$transaction([
      p.cpLead.update({
        where: { id: l.id },
        data: { status, last_called_at: new Date(), next_follow_up_at: followUp },
      }),
      p.cpLeadActivity.create({
        data: {
          cp_lead_id: l.id,
          cp_id: req.cp!.id,
          actor_user_id: req.cp!.user?.id ?? null,
          actor_name: actorName(req),
          kind: 'CALL',
          outcome: body.data.outcome,
          notes: body.data.notes || null,
        },
      }),
    ]);
    return res.status(201).json({ ok: true, status });
  }),
);

router.post(
  '/leads/:id/status',
  requireCp,
  handle(async (req, res) => {
    const status = String(req.body?.status || '');
    if (!(LEAD_STATUSES as readonly string[]).includes(status))
      throw fail(400, 'Pick a valid status.');
    const l = await ownLead(req, idOf(req.params.id));
    if (l.status === 'VISIT_BOOKED')
      throw fail(409, 'A visit is booked for this lead. Manage it from Visits.');
    await p.$transaction([
      p.cpLead.update({ where: { id: l.id }, data: { status } }),
      p.cpLeadActivity.create({
        data: {
          cp_lead_id: l.id,
          cp_id: req.cp!.id,
          actor_user_id: req.cp!.user?.id ?? null,
          actor_name: actorName(req),
          kind: 'STATUS',
          outcome: status,
          notes: `Status set to ${status.replace(/_/g, ' ').toLowerCase()}.`,
        },
      }),
    ]);
    return res.status(200).json({ ok: true });
  }),
);

router.post(
  '/leads/:id/notes',
  requireCp,
  handle(async (req, res) => {
    const notes = String(req.body?.notes || '').trim();
    if (notes.length < 2 || notes.length > 2000)
      throw fail(400, 'Write a note (up to 2000 characters).');
    const l = await ownLead(req, idOf(req.params.id));
    await p.cpLeadActivity.create({
      data: {
        cp_lead_id: l.id,
        cp_id: req.cp!.id,
        actor_user_id: req.cp!.user?.id ?? null,
        actor_name: actorName(req),
        kind: 'NOTE',
        notes,
      },
    });
    return res.status(201).json({ ok: true });
  }),
);

router.post(
  '/leads/:id/assign',
  requireCp,
  requireOwner,
  handle(async (req, res) => {
    const l = await ownLead(req, idOf(req.params.id));
    const toId = await assignee(req, Number(req.body?.assign_to_id) || null);
    const names = await namesOf(req.cp!.id);
    await p.$transaction([
      p.cpLead.update({ where: { id: l.id }, data: { assigned_to_id: toId } }),
      p.cpLeadActivity.create({
        data: {
          cp_lead_id: l.id,
          cp_id: req.cp!.id,
          actor_user_id: null,
          actor_name: actorName(req),
          kind: 'ASSIGN',
          notes: toId ? `Assigned to ${names.get(toId)}.` : 'Taken back by the partner.',
        },
      }),
    ]);
    return res.status(200).json({ ok: true });
  }),
);

// ── lead details: qualification, drop, matches ───────────────

const EditLeadSchema = z.object({
  customer_name: z.string().trim().min(2).max(120).optional(),
  email: z.string().trim().max(120).optional().nullable(),
  alt_phone: z.string().trim().max(20).optional().nullable(),
  notes: z.string().trim().max(2000).optional().nullable(),
  budget_min: z.number().min(0).max(1e11).optional().nullable(),
  budget_max: z.number().min(0).max(1e11).optional().nullable(),
  preferred_locations: z.string().trim().max(255).optional().nullable(),
  property_type: z.string().trim().max(40).optional().nullable(),
});

router.patch(
  '/leads/:id',
  requireCp,
  handle(async (req, res) => {
    const body = EditLeadSchema.safeParse(req.body);
    if (!body.success) throw fail(400, body.error.issues[0]?.message || 'Check the details.');
    const l = await ownLead(req, idOf(req.params.id));
    const d = body.data;
    if (d.budget_min != null && d.budget_max != null && d.budget_min > d.budget_max) {
      throw fail(400, 'The lowest budget is higher than the highest.');
    }
    let alt: string | null | undefined = undefined;
    if (d.alt_phone !== undefined) {
      alt = d.alt_phone ? normalizeCpPhone(d.alt_phone) : null;
      if (d.alt_phone && !alt) throw fail(400, 'The other number is not a valid 10-digit mobile.');
    }
    const data: Record<string, unknown> = {};
    if (d.customer_name !== undefined) data.customer_name = d.customer_name;
    if (d.email !== undefined) data.email = d.email || null;
    if (alt !== undefined) data.alt_phone = alt;
    if (d.notes !== undefined) data.notes = d.notes || null;
    if (d.budget_min !== undefined) data.budget_min = d.budget_min;
    if (d.budget_max !== undefined) data.budget_max = d.budget_max;
    if (d.preferred_locations !== undefined)
      data.preferred_locations = d.preferred_locations || null;
    if (d.property_type !== undefined) data.property_type = d.property_type || null;
    if (!Object.keys(data).length) throw fail(400, 'Nothing to change.');
    await p.$transaction([
      p.cpLead.update({ where: { id: l.id }, data }),
      p.cpLeadActivity.create({
        data: {
          cp_lead_id: l.id,
          cp_id: req.cp!.id,
          actor_user_id: req.cp!.user?.id ?? null,
          actor_name: actorName(req),
          kind: 'NOTE',
          notes: 'Details updated.',
        },
      }),
    ]);
    return res.status(200).json({ ok: true });
  }),
);

const DROP_REASONS = [
  'Not interested',
  'Budget too low',
  'Bought elsewhere',
  'Wrong number',
  'Not reachable',
  'Looking for something we do not have',
  'Other',
] as const;

router.post(
  '/leads/:id/drop',
  requireCp,
  handle(async (req, res) => {
    const reason = String(req.body?.reason || '');
    if (!(DROP_REASONS as readonly string[]).includes(reason)) throw fail(400, 'Pick a reason.');
    const detail = String(req.body?.detail || '')
      .trim()
      .slice(0, 500);
    if (reason === 'Other' && detail.length < 3) throw fail(400, 'Say what the reason is.');
    const l = await ownLead(req, idOf(req.params.id));
    if (l.status === 'VISIT_BOOKED')
      throw fail(409, 'A visit is booked. Cancel or finish it first.');
    await p.$transaction([
      p.cpLead.update({
        where: { id: l.id },
        data: { status: 'DROPPED', next_follow_up_at: null },
      }),
      p.cpTask.updateMany({
        where: { cp_lead_id: l.id, cp_id: req.cp!.id, done_at: null },
        data: { done_at: new Date() },
      }),
      p.cpLeadActivity.create({
        data: {
          cp_lead_id: l.id,
          cp_id: req.cp!.id,
          actor_user_id: req.cp!.user?.id ?? null,
          actor_name: actorName(req),
          kind: 'STATUS',
          outcome: 'DROPPED',
          notes: `Dropped: ${reason}${detail ? `. ${detail}` : ''}`,
        },
      }),
    ]);
    return res.status(200).json({ ok: true });
  }),
);

router.get('/drop-reasons', requireCp, (_req, res) =>
  res.status(200).json({ reasons: DROP_REASONS }),
);

/** Projects and properties that fit what this customer asked for (budget and place). */
router.get(
  '/leads/:id/matches',
  requireCp,
  handle(async (req, res) => {
    const l = await ownLead(req, idOf(req.params.id));
    const words = String(l.preferred_locations || '')
      .split(/[,;/]/)
      .map((x) => x.trim())
      .filter((x) => x.length >= 3)
      .slice(0, 5);
    const min = l.budget_min ?? 0;
    const max = l.budget_max ?? null;
    const place = (fields: string[]) =>
      words.length
        ? { OR: words.flatMap((w) => fields.map((f) => ({ [f]: { contains: w } }))) }
        : {};
    const unitFilter: any = {
      sales_status: 'AVAILABLE',
      final_price: { gt: 0, gte: min, ...(max ? { lte: max } : {}) },
    };
    const projects = await p.project.findMany({
      where: {
        ...liveProject,
        ...place(['location', 'city', 'name']),
        units: { some: unitFilter },
      },
      select: {
        id: true,
        name: true,
        location: true,
        city: true,
        project_type: true,
        cover_image_url: true,
      },
      take: 10,
    });
    const priced = projects.length
      ? await p.projectUnit.groupBy({
          by: ['project_id'],
          where: { project_id: { in: projects.map((x: any) => x.id) }, ...unitFilter },
          _count: { _all: true },
          _min: { final_price: true },
        })
      : [];
    const byProject = new Map<number, any>(priced.map((x: any) => [x.project_id, x]));
    const properties = await p.property.findMany({
      where: {
        status: 'LIVE',
        sales_status: 'AVAILABLE',
        final_price: { gt: 0, gte: min, ...(max ? { lte: max } : {}) },
        ...place(['city', 'locality', 'title']),
        ...(l.property_type ? { category: l.property_type } : {}),
      },
      select: {
        id: true,
        title: true,
        category: true,
        city: true,
        locality: true,
        final_price: true,
      },
      take: 10,
    });
    return res.status(200).json({
      projects: projects.map((x: any) => ({
        ...x,
        matching_units: byProject.get(x.id)?._count._all ?? 0,
        price_from: Number(byProject.get(x.id)?._min.final_price) || null,
      })),
      properties,
    });
  }),
);

// ── tasks and reminders ──────────────────────────────────────

const taskScope = (req: CpRequest) =>
  req.cp!.user
    ? {
        cp_id: req.cp!.id,
        OR: [{ assigned_to_id: req.cp!.user.id }, { created_by_id: req.cp!.user.id }],
      }
    : { cp_id: req.cp!.id };

router.get(
  '/tasks',
  requireCp,
  handle(async (req, res) => {
    const istNow = new Date(Date.now() + 330 * 60000);
    const today = istNow.toISOString().slice(0, 10);
    const endOfToday = new Date(`${today}T23:59:59+05:30`);
    const scopeName = String(req.query.scope || 'open');
    const where: any = { ...taskScope(req) };
    if (scopeName === 'done') where.done_at = { not: null };
    else where.done_at = null;
    const rows = await p.cpTask.findMany({
      where,
      orderBy: scopeName === 'done' ? { done_at: 'desc' } : { due_at: 'asc' },
      take: 200,
    });
    const leadIds = [
      ...new Set<number>(rows.filter((r: any) => r.cp_lead_id).map((r: any) => r.cp_lead_id)),
    ];
    const leads = leadIds.length
      ? await p.cpLead.findMany({
          where: { id: { in: leadIds }, cp_id: req.cp!.id },
          select: { id: true, customer_name: true, phone: true },
        })
      : [];
    const byLead = new Map<number, any>(leads.map((x: any) => [x.id, x]));
    const names = await namesOf(req.cp!.id);
    return res.status(200).json({
      tasks: rows.map((t: any) => ({
        id: t.id,
        title: t.title,
        due_at: t.due_at,
        done_at: t.done_at,
        overdue: !t.done_at && t.due_at < new Date(),
        due_today: !t.done_at && t.due_at <= endOfToday,
        assigned_to_name: t.assigned_to_id ? names.get(t.assigned_to_id) || null : null,
        lead: t.cp_lead_id ? byLead.get(t.cp_lead_id) || null : null,
      })),
    });
  }),
);

const NewTaskSchema = z.object({
  title: z.string().trim().min(3).max(200),
  due_at: z.string().min(8),
  lead_id: z.number().int().positive().optional().nullable(),
  assign_to_id: z.number().int().positive().optional().nullable(),
});

router.post(
  '/tasks',
  requireCp,
  handle(async (req, res) => {
    const body = NewTaskSchema.safeParse(req.body);
    if (!body.success)
      throw fail(400, body.error.issues[0]?.message || 'Give the task a title and a time.');
    const due = new Date(body.data.due_at);
    if (Number.isNaN(due.getTime())) throw fail(400, 'The time is not valid.');
    if (body.data.lead_id) await ownLead(req, body.data.lead_id);
    const toId = await assignee(req, body.data.assign_to_id);
    const t = await p.cpTask.create({
      data: {
        cp_id: req.cp!.id,
        cp_lead_id: body.data.lead_id ?? null,
        title: body.data.title,
        due_at: due,
        assigned_to_id: toId,
        created_by_id: req.cp!.user?.id ?? null,
      },
    });
    return res.status(201).json({ task: { id: t.id } });
  }),
);

router.post(
  '/tasks/:id/done',
  requireCp,
  handle(async (req, res) => {
    const id = idOf(req.params.id);
    const t = await p.cpTask.findFirst({ where: { id, ...taskScope(req) } });
    if (!t) throw fail(404, 'Task not found');
    await p.cpTask.update({ where: { id }, data: { done_at: req.body?.undo ? null : new Date() } });
    return res.status(200).json({ ok: true });
  }),
);

// ── the bell ─────────────────────────────────────────────────

/** Small counts for the bell in the header: office messages not read, call-backs and reminders due now. */
router.get(
  '/badges',
  requireCp,
  handle(async (req, res) => {
    const cp = req.cp!;
    const now = new Date();
    const open = ['NEW', 'CONTACTED', 'INTERESTED', 'VISIT_BOOKED'];
    const [messages, callBacks, tasks] = await Promise.all([
      cp.user
        ? Promise.resolve(0)
        : p.notification.count({
            where: { employee_id: cp.id, is_read: false, is_dismissed: false },
          }),
      p.cpLead.count({
        where: {
          ...(leadScope(req) as any),
          status: { in: open },
          next_follow_up_at: { lte: now },
        },
      }),
      p.cpTask.count({
        where: { ...(taskScope(req) as any), done_at: null, due_at: { lte: now } },
      }),
    ]);
    return res.status(200).json({
      messages_unread: messages,
      call_backs_due: callBacks,
      tasks_due: tasks,
      total: messages + callBacks + tasks,
    });
  }),
);

// ── home screen ──────────────────────────────────────────────

/** What this person needs today, in one call: counts, call-backs due, next visits, and for the partner the team. */
router.get(
  '/overview',
  requireCp,
  handle(async (req, res) => {
    const cp = req.cp!;
    const scope = leadScope(req) as any;
    const istNow = new Date(Date.now() + 330 * 60000);
    const today = istNow.toISOString().slice(0, 10);
    const endOfToday = new Date(`${today}T23:59:59+05:30`);
    const monthStart = new Date(`${today.slice(0, 7)}-01T00:00:00+05:30`);
    const weekAgo = new Date(Date.now() - 7 * 86400e3);
    const open = ['NEW', 'CONTACTED', 'INTERESTED', 'VISIT_BOOKED'];
    const visitWhere = await visitScope(req);
    const upcoming = {
      scheduled_date: { gte: new Date(Date.now() - 12 * 3600e3) },
      status: { notIn: ['COMPLETED', 'CANCELLED'] },
    };
    const [byStatus, due, dueCount, nextVisits, upcomingCount, doneMonth, bookings] =
      await Promise.all([
        p.cpLead.groupBy({ by: ['status'], where: scope, _count: { _all: true } }),
        p.cpLead.findMany({
          where: { ...scope, status: { in: open }, next_follow_up_at: { lte: endOfToday } },
          orderBy: { next_follow_up_at: 'asc' },
          take: 6,
          select: {
            id: true,
            customer_name: true,
            phone: true,
            status: true,
            next_follow_up_at: true,
          },
        }),
        p.cpLead.count({
          where: { ...scope, status: { in: open }, next_follow_up_at: { lte: endOfToday } },
        }),
        p.siteVisitBooking.findMany({
          where: { AND: [visitWhere, upcoming] },
          orderBy: { scheduled_date: 'asc' },
          take: 3,
          select: visitSelect,
        }),
        p.siteVisitBooking.count({ where: { AND: [visitWhere, upcoming] } }),
        p.siteVisitBooking.count({
          where: { AND: [visitWhere, { status: 'COMPLETED', completed_at: { gte: monthStart } }] },
        }),
        cp.user
          ? Promise.resolve(0)
          : p.booking.count({
              where: {
                opportunity: { lead: { cp_owner_id: cp.id } },
                booking_date: { gte: monthStart },
              },
            }),
      ]);
    const taskWhere = { ...taskScope(req), done_at: null, due_at: { lte: endOfToday } } as any;
    const [tasksDue, taskItems] = await Promise.all([
      p.cpTask.count({ where: taskWhere }),
      p.cpTask.findMany({
        where: taskWhere,
        orderBy: { due_at: 'asc' },
        take: 5,
        select: { id: true, title: true, due_at: true, cp_lead_id: true },
      }),
    ]);
    const counts: Record<string, number> = Object.fromEntries(
      byStatus.map((x: any) => [x.status, x._count._all]),
    );
    let team: unknown[] | undefined;
    if (!cp.user) {
      const [users, assigned, calls] = await Promise.all([
        p.cpUser.findMany({
          where: { cp_id: cp.id, is_active: true },
          select: { id: true, full_name: true },
          orderBy: { id: 'asc' },
        }),
        p.cpLead.groupBy({
          by: ['assigned_to_id'],
          where: { cp_id: cp.id, assigned_to_id: { not: null } },
          _count: { _all: true },
        }),
        p.cpLeadActivity.groupBy({
          by: ['actor_user_id'],
          where: {
            cp_id: cp.id,
            kind: 'CALL',
            actor_user_id: { not: null },
            created_at: { gte: weekAgo },
          },
          _count: { _all: true },
        }),
      ]);
      const a = new Map<number, number>(
        assigned.map((x: any) => [x.assigned_to_id, x._count._all]),
      );
      const c = new Map<number, number>(calls.map((x: any) => [x.actor_user_id, x._count._all]));
      team = users.map((u: any) => ({
        id: u.id,
        full_name: u.full_name,
        leads: a.get(u.id) ?? 0,
        calls_7d: c.get(u.id) ?? 0,
      }));
    }
    return res.status(200).json({
      leads: {
        total: Object.values(counts).reduce((x, y) => x + y, 0),
        open: open.reduce((n, k) => n + (counts[k] || 0), 0),
        new: counts.NEW || 0,
        interested: counts.INTERESTED || 0,
        visit_booked: counts.VISIT_BOOKED || 0,
      },
      follow_ups: { count: dueCount, items: due },
      tasks: { count: tasksDue, items: taskItems },
      visits: {
        upcoming: upcomingCount,
        done_this_month: doneMonth,
        next: nextVisits.map((v: any) => toCpVisit(v, cp.id)),
      },
      bookings_this_month: bookings,
      team,
    });
  }),
);

// ── our projects and properties (read only) ───────────────────

const CAT_PROJECT = {
  id: true,
  project_code: true,
  name: true,
  description: true,
  location: true,
  city: true,
  project_type: true,
  status: true,
  project_phase: true,
  total_units: true,
  launch_date: true,
  rera_number: true,
  amenities: true,
  cover_image_url: true,
  maps_link: true,
  approval_authorities: true,
  approval_authority: true,
  total_area_value: true,
  total_area_unit: true,
  // Internal only: partners and our team may see these, the public website never does.
  bank_loan_available: true,
  payment_terms: true,
} as const;

/** Acres from a project's total area, or null when the unit cannot be converted. */
const toAcres = (value: number | null, unit: string | null) => {
  if (!value || !unit) return null;
  const perAcre: Record<string, number> = {
    ACRE: 1,
    HECTARE: 2.47105,
    SQFT: 1 / 43560,
    SQYD: 1 / 4840,
    SQM: 1 / 4046.856,
    GUNTA: 1 / 40,
    CENT: 1 / 100,
  };
  const k = perAcre[unit];
  return k ? Math.round(value * k * 100) / 100 : null;
};
const CAT_UNIT = {
  id: true,
  unit_number: true,
  unit_type: true,
  bhk: true,
  area_sqft: true,
  area_sqyd: true,
  facing: true,
  final_price: true,
  sales_status: true,
} as const;
const CAT_PROPERTY = {
  id: true,
  property_code: true,
  title: true,
  category: true,
  listing_type: true,
  city: true,
  locality: true,
  area_sqft: true,
  bedrooms: true,
  final_price: true,
  sales_status: true,
  possession_status: true,
  images: {
    where: { status: { in: ['APPROVED', 'PENDING'] } },
    select: { id: true, image_url: true, is_primary: true },
    orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
    take: 6,
  },
} as const;
// Owner contacts, internal notes, who submitted it and GPS are never selected.

const liveProject = {
  verification_status: 'VERIFIED',
  status: { notIn: ['CANCELLED', 'ON_HOLD'] },
};

router.get(
  '/catalog/projects',
  requireCp,
  handle(async (req, res) => {
    const q = String(req.query.q || '').trim();
    const projects = await p.project.findMany({
      where: {
        ...liveProject,
        ...(q
          ? {
              OR: [
                { name: { contains: q } },
                { location: { contains: q } },
                { city: { contains: q } },
              ],
            }
          : {}),
      },
      select: CAT_PROJECT,
      orderBy: { name: 'asc' },
      take: 200,
    });
    const free = projects.length
      ? await p.projectUnit.groupBy({
          by: ['project_id'],
          where: { project_id: { in: projects.map((x: any) => x.id) }, sales_status: 'AVAILABLE' },
          _count: { _all: true },
          _min: { final_price: true },
          _max: { final_price: true },
        })
      : [];
    const avail = new Map<number, any>(free.map((f: any) => [f.project_id, f]));
    const given = new Set<number>(
      (
        await p.cpProjectAssignment.findMany({
          where: { cp_id: req.cp!.id },
          select: { project_id: true },
        })
      ).map((g: any) => g.project_id),
    );
    return res.status(200).json({
      projects: projects.map((x: any) => ({
        ...x,
        assigned: given.has(x.id),
        available_units: avail.get(x.id)?._count._all ?? 0,
        price_from: Number(avail.get(x.id)?._min.final_price) || null,
        price_to: Number(avail.get(x.id)?._max.final_price) || null,
      })),
    });
  }),
);

router.get(
  '/catalog/projects/:id',
  requireCp,
  handle(async (req, res) => {
    const id = idOf(req.params.id);
    const project = await p.project.findFirst({
      where: { id, ...liveProject },
      select: CAT_PROJECT,
    });
    if (!project) throw fail(404, 'Project not found');
    const [units, media, amenities, summary] = await Promise.all([
      p.projectUnit.findMany({
        where: { project_id: id },
        select: CAT_UNIT,
        orderBy: [{ sales_status: 'asc' }, { id: 'asc' }],
        take: 400,
      }),
      // Photos, videos and plans only. Legal and approval documents stay with us.
      p.projectMedia.findMany({
        where: { project_id: id },
        select: { id: true, kind: true, url: true, title: true },
        orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
        take: 120,
      }),
      p.projectAmenity.findMany({
        where: { project_id: id },
        select: { amenity: { select: { name: true, category: true } } },
        orderBy: { sort_order: 'asc' },
        take: 80,
      }),
      p.projectUnit.groupBy({
        by: ['sales_status'],
        where: { project_id: id },
        _count: { _all: true },
      }),
    ]);
    const plotSizes = [
      ...new Set<number>(
        units
          .map((u: any) => Number(u.area_sqyd) || 0)
          .filter((n: number) => n > 0)
          .map((n: number) => Math.round(n * 10) / 10),
      ),
    ].sort((a, b) => a - b);
    const freePrices = units
      .filter((u: any) => u.sales_status === 'AVAILABLE' && Number(u.final_price) > 0)
      .map((u: any) => Number(u.final_price));
    const facts = {
      approved_by: [
        ...(Array.isArray(project.approval_authorities) ? project.approval_authorities : []),
        ...(project.approval_authority ? [project.approval_authority] : []),
      ].filter((v: unknown, i: number, a: unknown[]) => a.indexOf(v) === i),
      total_area_acres: toAcres(
        project.total_area_value === null ? null : Number(project.total_area_value),
        project.total_area_unit,
      ),
      number_of_plots: units.length || project.total_units || null,
      available_plots: units.filter((u: any) => u.sales_status === 'AVAILABLE').length,
      plot_sizes_sqyd: plotSizes,
      price_min: freePrices.length ? Math.min(...freePrices) : null,
      price_max: freePrices.length ? Math.max(...freePrices) : null,
      bank_loan_available: project.bank_loan_available ?? null,
    };
    return res.status(200).json({
      project,
      facts,
      units,
      media,
      amenities: amenities.map((a: any) => a.amenity),
      summary: Object.fromEntries(summary.map((x: any) => [x.sales_status, x._count._all])),
    });
  }),
);

// The projects this partner (or their team) sent us: waiting, being added, or live in our CRM.
router.get(
  '/my-projects',
  requireCp,
  handle(async (req, res) => {
    const drafts = await p.draftSubmission.findMany({
      where: { submitted_by: req.cp!.id, type: 'PROJECT' },
      orderBy: { id: 'desc' },
      take: 100,
      select: {
        id: true,
        title: true,
        location: true,
        city: true,
        status: true,
        created_at: true,
        linked_project: { select: { ...CAT_PROJECT, verification_status: true } },
      },
    });
    const live = drafts
      .map((d: any) => d.linked_project)
      .filter((x: any) => x && x.verification_status === 'VERIFIED');
    const free = live.length
      ? await p.projectUnit.groupBy({
          by: ['project_id'],
          where: { project_id: { in: live.map((x: any) => x.id) }, sales_status: 'AVAILABLE' },
          _count: { _all: true },
          _min: { final_price: true },
          _max: { final_price: true },
        })
      : [];
    const avail = new Map<number, any>(free.map((f: any) => [f.project_id, f]));
    return res.status(200).json({
      projects: drafts.map((d: any) => {
        const x =
          d.linked_project && d.linked_project.verification_status === 'VERIFIED'
            ? d.linked_project
            : null;
        return {
          draft_id: d.id,
          name: x?.name ?? d.title,
          location: x?.location ?? d.location,
          city: x?.city ?? d.city,
          status: d.status,
          sent_at: d.created_at,
          // The project is open in the catalog only once it is live in our CRM.
          project: x
            ? {
                ...x,
                available_units: avail.get(x.id)?._count._all ?? 0,
                price_from: Number(avail.get(x.id)?._min.final_price) || null,
                price_to: Number(avail.get(x.id)?._max.final_price) || null,
              }
            : null,
        };
      }),
    });
  }),
);

router.get(
  '/catalog/properties',
  requireCp,
  handle(async (req, res) => {
    const q = String(req.query.q || '').trim();
    const rows = await p.property.findMany({
      where: {
        status: 'LIVE',
        ...(q
          ? {
              OR: [
                { title: { contains: q } },
                { city: { contains: q } },
                { locality: { contains: q } },
              ],
            }
          : {}),
      },
      select: CAT_PROPERTY,
      orderBy: { id: 'desc' },
      take: 200,
    });
    return res.status(200).json({ properties: rows });
  }),
);

router.get(
  '/catalog/properties/:id',
  requireCp,
  handle(async (req, res) => {
    const id = idOf(req.params.id);
    const row = await p.property.findFirst({
      where: { id, status: 'LIVE' },
      select: {
        ...CAT_PROPERTY,
        description: true,
        state: true,
        pincode: true,
        listing_type: true,
      },
    });
    if (!row) throw fail(404, 'Property not found');
    return res.status(200).json({ property: row });
  }),
);

// ── site visits ───────────────────────────────────────────────

const firstName = (name?: string | null) => (name || '').trim().split(/\s+/)[0] || 'Customer';

const visitSelect = {
  id: true,
  booking_code: true,
  scheduled_date: true,
  status: true,
  lead_id: true,
  assigned_agent_id: true,
  project_manager_id: true,
  rating: true,
  feedback_notes: true,
  lead: {
    select: { customer_name: true, phone: true, cp_owner_id: true, referred_to_cp_id: true },
  },
  project: { select: { name: true, location: true, city: true, maps_link: true } },
  property: { select: { title: true, location: true, city: true } },
  project_manager: { select: { full_name: true, phone: true } },
} as const;

/** The partner's view of a visit: built field by field, never by spreading a record. */
const toCpVisit = (v: any, cpId: number) => {
  // Your own customers, and the customers our office referred to you, are shown in full.
  const own = v.lead?.cp_owner_id === cpId || v.lead?.referred_to_cp_id === cpId;
  return {
    id: v.id,
    booking_code: v.booking_code,
    scheduled_date: v.scheduled_date,
    status: v.status,
    place: v.project
      ? {
          name: v.project.name,
          location: v.project.location,
          city: v.project.city,
          maps_link: v.project.maps_link,
        }
      : v.property
        ? {
            name: v.property.title,
            location: v.property.location,
            city: v.property.city,
            maps_link: null,
          }
        : null,
    customer_first_name: firstName(v.lead?.customer_name),
    // Your own customers are shown in full; a customer our staff handed you is first name only.
    customer_name: own ? v.lead?.customer_name : undefined,
    customer_phone: own ? v.lead?.phone : undefined,
    own,
    run_by: v.assigned_agent_id === cpId ? 'PARTNER' : v.project_manager_id ? 'OUR_PM' : 'NOBODY',
    can_finish:
      own && v.assigned_agent_id === cpId && ['CONFIRMED', 'ACTIVE', 'ACCEPTED'].includes(v.status),
    rating: own ? v.rating : undefined,
    pm: v.project_manager
      ? { name: v.project_manager.full_name, phone: v.project_manager.phone }
      : null,
  };
};

/** Visits visible to this person: the partner and their PM see the group's; a telecaller sees those of their own leads. */
const visitScope = async (req: CpRequest) => {
  const cpId = req.cp!.id;
  const teamUser = req.cp!.user;
  if (!teamUser || isGroupWide(req)) {
    return {
      OR: [
        { assigned_agent_id: cpId },
        { lead: { cp_owner_id: cpId } },
        { lead: { referred_to_cp_id: cpId } },
      ],
      lead: { company_id: req.cp!.company_id },
    };
  }
  const mine = await p.cpLead.findMany({
    where: { ...(leadScope(req) as any), lead_id: { not: null } },
    select: { lead_id: true },
  });
  const referred = await p.cpReferral.findMany({
    where: {
      cp_id: cpId,
      assigned_to_id: teamUser.id,
      status: { in: ['OFFERED', 'ACCEPTED'] },
    },
    select: { lead_id: true },
  });
  return {
    OR: [
      { lead_id: { in: mine.map((m: any) => m.lead_id) }, lead: { cp_owner_id: cpId } },
      { lead_id: { in: referred.map((m: any) => m.lead_id) }, lead: { referred_to_cp_id: cpId } },
    ],
  };
};

router.get(
  '/visits',
  requireCp,
  handle(async (req, res) => {
    const past = req.query.scope === 'past';
    const now = new Date();
    const scope = await visitScope(req);
    // The time filter is combined with the scope using AND: spreading both would let the time
    // filter's own OR replace the scope's OR and show every visit of the company.
    const timeFilter = past
      ? { OR: [{ scheduled_date: { lt: now } }, { status: { in: ['COMPLETED', 'CANCELLED'] } }] }
      : {
          scheduled_date: { gte: new Date(now.getTime() - 12 * 3600e3) },
          status: { notIn: ['COMPLETED', 'CANCELLED'] },
        };
    const visits = await p.siteVisitBooking.findMany({
      where: { AND: [scope, timeFilter] },
      select: visitSelect,
      orderBy: { scheduled_date: past ? 'desc' : 'asc' },
      take: 100,
    });
    return res.status(200).json({ visits: visits.map((v: any) => toCpVisit(v, req.cp!.id)) });
  }),
);

router.get(
  '/visits/:id',
  requireCp,
  handle(async (req, res) => {
    const id = idOf(req.params.id);
    const scope = await visitScope(req);
    const v = await p.siteVisitBooking.findFirst({ where: { id, ...scope }, select: visitSelect });
    if (!v) throw fail(404, 'Visit not found');
    return res.status(200).json({ visit: toCpVisit(v, req.cp!.id) });
  }),
);

const BookVisitSchema = z
  .object({
    project_id: z.number().int().positive().optional().nullable(),
    property_id: z.number().int().positive().optional().nullable(),
    unit_ids: z.array(z.number().int().positive()).max(10).optional(),
    scheduled_date: z.string().min(8),
    mode: z.enum(['SELF', 'OUR_PM']),
    notes: z.string().trim().max(500).optional().nullable(),
  })
  .refine((v) => !!v.project_id || !!v.property_id, {
    message: 'Pick the project or property to visit.',
  });

router.post(
  '/leads/:id/visit',
  requireCp,
  handle(async (req, res) => {
    const body = BookVisitSchema.safeParse(req.body);
    if (!body.success) throw fail(400, body.error.issues[0]?.message || 'Check the visit details.');
    const when = new Date(body.data.scheduled_date);
    if (Number.isNaN(when.getTime()) || when.getTime() < Date.now() - 3600e3) {
      throw fail(400, 'Pick a date and time that has not passed.');
    }
    const cp = req.cp!;
    const l = await ownLead(req, idOf(req.params.id));
    if (['NOT_INTERESTED', 'DROPPED'].includes(l.status)) throw fail(409, 'This lead is closed.');
    // The place must be one the partner can see.
    if (body.data.project_id) {
      const ok = await p.project.findFirst({
        where: { id: body.data.project_id, ...liveProject },
        select: { id: true },
      });
      if (!ok) throw fail(404, 'Project not found');
    } else {
      const ok = await p.property.findFirst({
        where: { id: body.data.property_id, status: 'LIVE' },
        select: { id: true },
      });
      if (!ok) throw fail(404, 'Property not found');
    }
    // Units of this project the customer wants to see (optional).
    let unitIds: number[] = [];
    if (body.data.unit_ids?.length) {
      if (!body.data.project_id) throw fail(400, 'Units belong to a project.');
      const found = await p.projectUnit.findMany({
        where: { id: { in: body.data.unit_ids }, project_id: body.data.project_id },
        select: { id: true },
      });
      if (found.length !== body.data.unit_ids.length)
        throw fail(404, 'One of the units was not found.');
      unitIds = found.map((u: any) => u.id);
    }
    // Our CRM gets the customer only now.
    let ourLeadId: number | null = l.lead_id;
    if (!ourLeadId) {
      const clash = await p.lead.findFirst({
        where: { company_id: cp.company_id, phone: l.phone },
        select: { id: true },
      });
      if (clash) {
        throw fail(
          409,
          'This customer is already known to our office. Please contact the office before booking a visit.',
        );
      }
      const made = await p.lead.create({
        data: {
          lead_code: await generateNextLeadCode(),
          company_id: cp.company_id,
          customer_name: l.customer_name,
          phone: l.phone,
          email: l.email,
          source: 'OTHER',
          source_detail: `Channel partner: ${cp.full_name || cp.employee_code}`.slice(0, 80),
          ownership_type: 'DIRECT',
          status: 'NEW',
          created_by_id: cp.id,
          cp_owner_id: cp.id,
        },
      });
      ourLeadId = made.id;
      await p.cpLead.update({ where: { id: l.id }, data: { lead_id: ourLeadId } });
    }
    const user = { ...asUser(req), permissions: [Permissions.SITE_VISITS_CREATE] };
    const self = body.data.mode === 'SELF';
    const visit: any = await bookVisit(user as any, {
      lead_id: ourLeadId,
      scheduled_date: when.toISOString(),
      project_id: body.data.project_id || undefined,
      property_id: body.data.property_id || undefined,
      project_unit_ids: unitIds.length ? unitIds : undefined,
      notes:
        `Booked by ${actorName(req)} (channel partner ${cp.full_name || cp.employee_code}). ${body.data.notes || ''}`.trim(),
      direct: self,
    });
    if (self) {
      // The partner runs it themselves.
      await p.siteVisitBooking.update({
        where: { id: visit.id },
        data: { assigned_agent_id: cp.id },
      });
    }
    await p.$transaction([
      p.cpLead.update({ where: { id: l.id }, data: { status: 'VISIT_BOOKED' } }),
      p.cpLeadActivity.create({
        data: {
          cp_lead_id: l.id,
          cp_id: cp.id,
          actor_user_id: cp.user?.id ?? null,
          actor_name: actorName(req),
          kind: 'VISIT',
          outcome: self ? 'SELF' : 'OUR_PM',
          notes: `Site visit ${visit.booking_code} booked (${self ? 'you run it' : 'our project manager runs it'}).`,
        },
      }),
    ]);
    return res
      .status(201)
      .json({ visit: { id: visit.id, booking_code: visit.booking_code, status: visit.status } });
  }),
);

const FinishSchema = z.object({
  rating: z.enum(['HOT_INTERESTED', 'WARM', 'COLD', 'NOT_INTERESTED']),
  feedback_notes: z.string().trim().min(3).max(1000),
});

router.post(
  '/visits/:id/finish',
  requireCp,
  handle(async (req, res) => {
    const body = FinishSchema.safeParse(req.body);
    if (!body.success) throw fail(400, 'Give the result and a short note.');
    const id = idOf(req.params.id);
    const scope = await visitScope(req);
    const v = await p.siteVisitBooking.findFirst({ where: { id, ...scope }, select: visitSelect });
    if (
      !v ||
      (v.lead?.cp_owner_id !== req.cp!.id && v.lead?.referred_to_cp_id !== req.cp!.id) ||
      v.assigned_agent_id !== req.cp!.id
    ) {
      throw fail(404, 'Visit not found');
    }
    if (!['CONFIRMED', 'ACTIVE', 'ACCEPTED'].includes(v.status))
      throw fail(409, 'This visit cannot be finished now.');
    await p.$transaction([
      p.siteVisitBooking.update({
        where: { id },
        data: {
          status: 'COMPLETED',
          completed_at: new Date(),
          rating: body.data.rating,
          feedback_notes: body.data.feedback_notes,
        },
      }),
      p.leadActivity.create({
        data: {
          lead_id: v.lead_id,
          actor_id: req.cp!.id,
          activity_type: 'SITE_VISIT_COMPLETED',
          notes:
            `Visit run by the channel partner. ${body.data.rating}: ${body.data.feedback_notes}`.slice(
              0,
              1000,
            ),
        },
      }),
    ]);
    return res.status(200).json({ ok: true });
  }),
);

router.post(
  '/visits/:id/cancel',
  requireCp,
  handle(async (req, res) => {
    const reason = String(req.body?.reason || '').trim();
    if (reason.length < 3) throw fail(400, 'Say why the visit is cancelled.');
    const id = idOf(req.params.id);
    const scope = await visitScope(req);
    const v = await p.siteVisitBooking.findFirst({ where: { id, ...scope }, select: visitSelect });
    if (
      !v ||
      (v.lead?.cp_owner_id !== req.cp!.id && v.lead?.referred_to_cp_id !== req.cp!.id) ||
      v.assigned_agent_id !== req.cp!.id
    ) {
      throw fail(404, 'Visit not found');
    }
    if (['COMPLETED', 'CANCELLED'].includes(v.status))
      throw fail(409, 'This visit is already closed.');
    await p.siteVisitBooking.update({
      where: { id },
      data: { status: 'CANCELLED', cancellation_reason: reason.slice(0, 500) },
    });
    return res.status(200).json({ ok: true });
  }),
);

// ── reports (the partner only) ────────────────────────────────

const csvCell = (v: unknown) => {
  let s =
    v === null || v === undefined
      ? ''
      : v instanceof Date
        ? v.toISOString().slice(0, 16).replace('T', ' ')
        : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};
const toCsv = (head: string[], rows: unknown[][]) =>
  '﻿' + [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

const range = (req: CpRequest) => {
  const to = req.query.to ? new Date(`${String(req.query.to)}T23:59:59+05:30`) : new Date();
  const from = req.query.from
    ? new Date(`${String(req.query.from)}T00:00:00+05:30`)
    : new Date(to.getTime() - 30 * 86400e3);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()))
    throw fail(400, 'The dates are not valid.');
  return { from, to };
};

async function reportData(req: CpRequest) {
  const cpId = req.cp!.id;
  const { from, to } = range(req);
  const [visits, bookings, drafts] = await Promise.all([
    p.siteVisitBooking.findMany({
      where: { lead: { cp_owner_id: cpId }, created_at: { gte: from, lte: to } },
      select: {
        booking_code: true,
        scheduled_date: true,
        status: true,
        rating: true,
        lead_id: true,
        project: { select: { name: true } },
        property: { select: { title: true } },
      },
      orderBy: { scheduled_date: 'desc' },
      take: 2000,
    }),
    p.booking.findMany({
      where: { opportunity: { lead: { cp_owner_id: cpId } }, booking_date: { gte: from, lte: to } },
      select: { booking_code: true, status: true, booking_date: true, agreed_price: true },
      orderBy: { booking_date: 'desc' },
      take: 2000,
    }),
    p.draftSubmission.findMany({
      where: { submitted_by: cpId, created_at: { gte: from, lte: to } },
      select: { id: true, type: true, title: true, status: true, created_at: true, ready_at: true },
      orderBy: { id: 'desc' },
      take: 2000,
    }),
  ]);
  // Who booked each visit: the partner's own record of it.
  const leadIds = [...new Set<number>(visits.map((v: any) => v.lead_id))];
  const links = leadIds.length
    ? await p.cpLead.findMany({
        where: { cp_id: cpId, lead_id: { in: leadIds } },
        select: { id: true, lead_id: true },
      })
    : [];
  const byLead = new Map<number, number>(links.map((l: any) => [l.lead_id, l.id]));
  const acts = links.length
    ? await p.cpLeadActivity.findMany({
        where: { cp_id: cpId, kind: 'VISIT', cp_lead_id: { in: links.map((l: any) => l.id) } },
        orderBy: { id: 'asc' },
        select: { cp_lead_id: true, actor_name: true },
      })
    : [];
  const bookedBy = new Map<number, string>();
  for (const a of acts) bookedBy.set(a.cp_lead_id, a.actor_name);
  const countBy = <T>(list: T[], key: (x: T) => string) => {
    const m: Record<string, number> = {};
    for (const x of list) m[key(x)] = (m[key(x)] || 0) + 1;
    return m;
  };
  return {
    range: { from, to },
    visits: {
      total: visits.length,
      by_status: countBy(visits, (v: any) => v.status),
      by_person: countBy(
        visits,
        (v: any) => bookedBy.get(byLead.get(v.lead_id) as number) || 'Partner',
      ),
      rows: visits.map((v: any) => ({
        booking_code: v.booking_code,
        scheduled_date: v.scheduled_date,
        status: v.status,
        rating: v.rating,
        place: v.project?.name || v.property?.title || '',
        booked_by: bookedBy.get(byLead.get(v.lead_id) as number) || 'Partner',
      })),
    },
    bookings: {
      total: bookings.length,
      by_status: countBy(bookings, (b: any) => b.status),
      total_value: bookings.reduce((a: number, b: any) => a + Number(b.agreed_price || 0), 0),
      rows: bookings.map((b: any) => ({
        booking_code: b.booking_code,
        status: b.status,
        booking_date: b.booking_date,
        agreed_price: Number(b.agreed_price || 0),
      })),
    },
    listings: {
      total: drafts.length,
      by_status: countBy(drafts, (d: any) => d.status),
      rows: drafts,
    },
  };
}

router.get(
  '/reports',
  requireCp,
  requireOwner,
  handle(async (req, res) => res.status(200).json(await reportData(req))),
);

router.get(
  '/reports/export',
  requireCp,
  requireOwner,
  handle(async (req, res) => {
    const kind = String(req.query.kind || '');
    const data = await reportData(req);
    let body = '';
    if (kind === 'visits') {
      body = toCsv(
        ['Visit', 'Date', 'Status', 'Result', 'Place', 'Booked by'],
        data.visits.rows.map((r: any) => [
          r.booking_code,
          r.scheduled_date,
          r.status,
          r.rating,
          r.place,
          r.booked_by,
        ]),
      );
    } else if (kind === 'bookings') {
      body = toCsv(
        ['Booking', 'Status', 'Date', 'Agreed price'],
        data.bookings.rows.map((r: any) => [
          r.booking_code,
          r.status,
          r.booking_date,
          r.agreed_price,
        ]),
      );
    } else if (kind === 'listings') {
      body = toCsv(
        ['Id', 'Type', 'Title', 'Status', 'Sent on', 'Ready on'],
        data.listings.rows.map((r: any) => [
          r.id,
          r.type,
          r.title,
          r.status,
          r.created_at,
          r.ready_at,
        ]),
      );
    } else throw fail(400, 'Pick visits, bookings or listings.');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="partner-${kind}.csv"`);
    return res.status(200).send(body);
  }),
);

export default router;
