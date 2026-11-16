import { Router, Response, NextFunction } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { hasEffectivePermission } from '../middleware/authz';
import { validateRequestBody } from '../middleware/validate';
import { Permissions } from '../shared';
import { getAccessibleCompanyIds } from '../authz/dataScope';
import { getStorageService, UPLOAD_DIR } from '../services/storage.service';
import { num } from '../utils/money';
import {
  ASSET_CATEGORIES,
  ASSET_CONDITIONS,
  ASSET_STATUSES,
  SIM_OPERATORS,
  isTracked,
} from '../services/assets';

/**
 * Asset management (2026-11-16): every company item with its price; laptops,
 * systems, mobiles, SIMs and tablets also record who holds them, with the full
 * history. HR (and MD / Admin) manage; the accountant views and exports;
 * everyone sees the items they hold (GET /my). Mounted at /api/v1/assets.
 */
const router = Router();
const p = prisma;

const can =
  (perm: string) => async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!(await hasEffectivePermission(req.user!, perm))) {
      return res.status(403).json({
        error:
          perm === Permissions.ASSETS_MANAGE
            ? 'Only HR can change assets.'
            : 'Assets are for HR, the MD and the accountant.',
      });
    }
    next();
  };
const canRead = can(Permissions.ASSETS_READ);
const canManage = can(Permissions.ASSETS_MANAGE);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (/\.(jpe?g|png|webp|pdf)$/i.test(file.originalname || '')) return cb(null, true);
    cb(Object.assign(new Error('Attach the bill as a photo or a PDF.'), { statusCode: 400 }));
  },
});

const dateOnly = (v?: string | null) => (v ? new Date(`${v}T00:00:00Z`) : null);
const ymd = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const holderSelect = { select: { id: true, full_name: true, employee_code: true } };

/** An asset as the pages show it: plain numbers and dates, never the file path. */
function view(a: any) {
  const { invoice_path, ...rest } = a;
  return {
    ...rest,
    purchase_price: a.purchase_price == null ? null : num(a.purchase_price),
    sim_plan_cost: a.sim_plan_cost == null ? null : num(a.sim_plan_cost),
    purchase_date: ymd(a.purchase_date),
    warranty_until: ymd(a.warranty_until),
    sim_due_date: ymd(a.sim_due_date),
    has_invoice: !!invoice_path,
    tracked: isTracked(a.category),
  };
}

/** An asset this person may see (their companies), or a 404. */
async function loadAsset(req: AuthenticatedRequest, id: number) {
  const ids = await getAccessibleCompanyIds(req.user!);
  const a = await p.asset.findFirst({ where: { id, company_id: { in: ids } } });
  if (!a) throw { status: 404, message: 'Asset not found' };
  return a;
}

// ── meta ───────────────────────────────────────────────────────

router.get('/meta', authenticateToken, canRead, async (req: AuthenticatedRequest, res) => {
  const ids = await getAccessibleCompanyIds(req.user!);
  const [companies, branches] = await Promise.all([
    p.company.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    p.branch.findMany({
      where: { company_id: { in: ids } },
      select: { id: true, name: true, company_id: true },
      orderBy: { name: 'asc' },
    }),
  ]);
  return res.json({
    categories: ASSET_CATEGORIES,
    statuses: ASSET_STATUSES,
    conditions: ASSET_CONDITIONS,
    sim_operators: SIM_OPERATORS,
    companies,
    branches,
    can_manage: await hasEffectivePermission(req.user!, Permissions.ASSETS_MANAGE),
  });
});

// ── list, summary, export ───────────────────────────────────────

async function listWhere(req: AuthenticatedRequest): Promise<Prisma.AssetWhereInput> {
  const ids = await getAccessibleCompanyIds(req.user!);
  const q = String(req.query.q || '')
    .trim()
    .slice(0, 80);
  const company = Number(req.query.company_id);
  const where: Prisma.AssetWhereInput = {
    company_id: { in: company && ids.includes(company) ? [company] : ids },
  };
  if (typeof req.query.category === 'string' && req.query.category)
    where.category = req.query.category;
  if (typeof req.query.status === 'string' && req.query.status) where.status = req.query.status;
  if (Number(req.query.branch_id)) where.branch_id = Number(req.query.branch_id);
  if (Number(req.query.holder_id)) where.holder_id = Number(req.query.holder_id);
  if (req.query.flag === 'NOT_RETURNED') {
    // Still with someone who has left.
    where.holder = { status: { not: 'ACTIVE' } };
  }
  if (q) {
    where.OR = [
      { asset_code: { contains: q } },
      { name: { contains: q } },
      { brand_model: { contains: q } },
      { serial_no: { contains: q } },
      { imei: { contains: q } },
      { sim_number: { contains: q } },
      { vendor: { contains: q } },
      { holder: { full_name: { contains: q } } },
      { holder: { employee_code: { contains: q } } },
    ];
  }
  return where;
}

router.get('/', authenticateToken, canRead, async (req: AuthenticatedRequest, res, next) => {
  try {
    const where = await listWhere(req);
    const take = Math.min(Math.max(Number(req.query.limit) || 300, 1), 1000);
    const [rows, total] = await Promise.all([
      p.asset.findMany({
        where,
        include: { holder: holderSelect },
        orderBy: { created_at: 'desc' }, // latest first
        take,
      }),
      p.asset.count({ where }),
    ]);
    return res.json({ assets: rows.map(view), total });
  } catch (err) {
    next(err);
  }
});

router.get('/summary', authenticateToken, canRead, async (req: AuthenticatedRequest, res, next) => {
  try {
    const ids = await getAccessibleCompanyIds(req.user!);
    const company = Number(req.query.company_id);
    const co = { company_id: { in: company && ids.includes(company) ? [company] : ids } };
    const live = { ...co, status: { notIn: ['SCRAPPED', 'LOST'] } };
    const today = new Date(
      `${new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10)}T00:00:00Z`,
    );
    const in30 = new Date(today.getTime() + 30 * 864e5);
    const in7 = new Date(today.getTime() + 7 * 864e5);
    const [rows, byStatus, warranty, simDue, notReturned] = await Promise.all([
      p.asset.findMany({
        where: live,
        select: { category: true, purchase_price: true, quantity: true },
      }),
      p.asset.groupBy({ by: ['status'], where: co, _count: { _all: true } }),
      p.asset.count({ where: { ...live, warranty_until: { gte: today, lte: in30 } } }),
      p.asset.count({
        where: { ...live, category: 'SIM', sim_due_date: { gte: today, lte: in7 } },
      }),
      p.asset.count({ where: { ...co, holder: { status: { not: 'ACTIVE' } } } }),
    ]);
    const byCategory: Record<string, { count: number; value: number }> = {};
    let total = 0;
    for (const r of rows) {
      const value = num(r.purchase_price) * (r.quantity || 1);
      total += value;
      const c = (byCategory[r.category] ||= { count: 0, value: 0 });
      c.count += r.quantity || 1;
      c.value = Math.round((c.value + value) * 100) / 100;
    }
    const status = (s: string) => byStatus.find((x) => x.status === s)?._count._all || 0;
    return res.json({
      total_value: Math.round(total * 100) / 100,
      by_category: Object.entries(byCategory)
        .map(([category, v]) => ({ category, ...v }))
        .sort((a, b) => b.value - a.value),
      in_use: status('IN_USE'),
      in_stock: status('IN_STOCK'),
      under_repair: status('UNDER_REPAIR'),
      warranty_ending: warranty,
      sim_due_this_week: simDue,
      not_returned: notReturned,
    });
  } catch (err) {
    next(err);
  }
});

const cell = (v: unknown) => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};

router.get('/export', authenticateToken, canRead, async (req: AuthenticatedRequest, res, next) => {
  try {
    const where = await listWhere(req);
    const rows = await p.asset.findMany({
      where,
      include: { holder: holderSelect },
      orderBy: { asset_code: 'asc' },
    });
    const companies = new Map(
      (await p.company.findMany({ select: { id: true, name: true } })).map((c) => [c.id, c.name]),
    );
    const branches = new Map(
      (await p.branch.findMany({ select: { id: true, name: true } })).map((b) => [b.id, b.name]),
    );
    const head = [
      'Code',
      'Name',
      'Category',
      'Company',
      'Branch',
      'Location',
      'Status',
      'Quantity',
      'Purchase price',
      'Total value',
      'Purchase date',
      'Vendor',
      'Invoice no.',
      'Warranty until',
      'Brand / model',
      'Serial no.',
      'IMEI',
      'SIM number',
      'Operator',
      'Plan',
      'Plan cost',
      'Next recharge / bill',
      'With (code)',
      'With (name)',
    ];
    const lines = rows.map((a) =>
      [
        a.asset_code,
        a.name,
        ASSET_CATEGORIES.find((c) => c.value === a.category)?.label || a.category,
        companies.get(a.company_id),
        a.branch_id ? branches.get(a.branch_id) : '',
        a.location,
        a.status,
        a.quantity,
        a.purchase_price == null ? '' : num(a.purchase_price),
        a.purchase_price == null ? '' : num(a.purchase_price) * a.quantity,
        ymd(a.purchase_date),
        a.vendor,
        a.invoice_no,
        ymd(a.warranty_until),
        a.brand_model,
        a.serial_no,
        a.imei,
        a.sim_number,
        a.sim_operator,
        a.sim_plan_type,
        a.sim_plan_cost == null ? '' : num(a.sim_plan_cost),
        ymd(a.sim_due_date),
        a.holder?.employee_code,
        a.holder?.full_name,
      ]
        .map(cell)
        .join(','),
    );
    const day = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="assets-${day}.csv"`);
    return res.send('﻿' + [head.map(cell).join(','), ...lines].join('\r\n') + '\r\n');
  } catch (err) {
    next(err);
  }
});

// ── what a person holds ─────────────────────────────────────────

const holdingSelect = {
  id: true,
  asset_code: true,
  name: true,
  category: true,
  brand_model: true,
  serial_no: true,
  imei: true,
  sim_number: true,
  status: true,
} as const;

/** My assets (everyone). */
router.get('/my', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
  try {
    const rows = await p.asset.findMany({
      where: { holder_id: req.user!.employeeId },
      select: {
        ...holdingSelect,
        assignments: {
          where: { employee_id: req.user!.employeeId, returned_at: null },
          select: { assigned_at: true, condition_out: true },
          take: 1,
        },
      },
      orderBy: { updated_at: 'desc' },
    });
    return res.json({
      assets: rows.map(({ assignments, ...a }) => ({
        ...a,
        since: assignments[0]?.assigned_at || null,
        condition: assignments[0]?.condition_out || null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/** What one employee holds now, and held before (HR, MD, accountant). */
router.get(
  '/employee/:employeeId',
  authenticateToken,
  canRead,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const employeeId = Number(req.params.employeeId) || 0;
      const ids = await getAccessibleCompanyIds(req.user!);
      const history = await p.assetAssignment.findMany({
        where: { employee_id: employeeId, asset: { company_id: { in: ids } } },
        include: { asset: { select: holdingSelect } },
        orderBy: { assigned_at: 'desc' },
        take: 200,
      });
      return res.json({
        holding: history.filter((h) => !h.returned_at),
        history: history.filter((h) => h.returned_at),
      });
    } catch (err) {
      next(err);
    }
  },
);

// ── one asset ──────────────────────────────────────────────────

router.get('/:id', authenticateToken, canRead, async (req: AuthenticatedRequest, res, next) => {
  try {
    const a = await loadAsset(req, Number(req.params.id) || 0);
    const [history, simIn, simsInside] = await Promise.all([
      p.assetAssignment.findMany({
        where: { asset_id: a.id },
        include: { employee: holderSelect },
        orderBy: { assigned_at: 'desc' },
      }),
      a.sim_in_asset_id
        ? p.asset.findUnique({
            where: { id: a.sim_in_asset_id },
            select: { id: true, asset_code: true, name: true },
          })
        : null,
      p.asset.findMany({
        where: { sim_in_asset_id: a.id },
        select: { id: true, asset_code: true, sim_number: true },
      }),
    ]);
    const people = new Map(
      (
        await p.employee.findMany({
          where: {
            id: {
              in: [
                ...history.map((h) => h.assigned_by_id),
                ...history.map((h) => h.returned_by_id).filter((x): x is number => !!x),
              ],
            },
          },
          select: { id: true, full_name: true },
        })
      ).map((e) => [e.id, e.full_name]),
    );
    const holder = a.holder_id
      ? await p.employee.findUnique({ where: { id: a.holder_id }, ...holderSelect })
      : null;
    return res.json({
      asset: { ...view(a), holder },
      sim_in: simIn,
      sims_inside: simsInside,
      history: history.map((h) => ({
        ...h,
        assigned_by: people.get(h.assigned_by_id) || null,
        returned_by: h.returned_by_id ? people.get(h.returned_by_id) || null : null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));
const optDate = z
  .string()
  .regex(DATE, 'Use a date')
  .optional()
  .nullable()
  .or(z.literal('').transform(() => null));
const optMoney = z.number().min(0).max(1e10).optional().nullable();

const AssetSchema = z.object({
  company_id: z.number().int().positive().optional(),
  branch_id: z.number().int().positive().optional().nullable(),
  category: z.enum(ASSET_CATEGORIES.map((c) => c.value) as [string, ...string[]]),
  name: z.string().trim().min(2, 'Give the asset a name').max(255),
  quantity: z.number().int().min(1).max(10000).optional(),
  location: optText(255),
  purchase_price: optMoney,
  purchase_date: optDate,
  vendor: optText(255),
  invoice_no: optText(100),
  warranty_until: optDate,
  brand_model: optText(255),
  serial_no: optText(100),
  imei: z
    .string()
    .trim()
    .regex(/^\d{14,17}$/, 'IMEI is 15 digits')
    .optional()
    .nullable()
    .or(z.literal('').transform(() => null)),
  specs: optText(500),
  licence: optText(255),
  sim_number: z
    .string()
    .trim()
    .regex(/^(\+91)?[6-9]\d{9}$/, 'Enter the 10-digit mobile number')
    .optional()
    .nullable()
    .or(z.literal('').transform(() => null)),
  sim_operator: z.enum(SIM_OPERATORS).optional().nullable(),
  sim_plan_type: z.enum(['PREPAID', 'POSTPAID']).optional().nullable(),
  sim_plan_cost: optMoney,
  sim_due_date: optDate,
  sim_in_asset_id: z.number().int().positive().optional().nullable(),
  notes: optText(2000),
});

/** The columns from a checked body; untracked items have no serial / IMEI / SIM fields. */
function columns(body: z.infer<typeof AssetSchema>) {
  const tracked = isTracked(body.category);
  const sim = body.category === 'SIM';
  return {
    branch_id: body.branch_id ?? null,
    category: body.category,
    name: body.name,
    quantity: tracked ? 1 : body.quantity || 1,
    location: body.location ?? null,
    purchase_price: body.purchase_price == null ? null : body.purchase_price.toFixed(2),
    purchase_date: dateOnly(body.purchase_date),
    vendor: body.vendor ?? null,
    invoice_no: body.invoice_no ?? null,
    warranty_until: dateOnly(body.warranty_until),
    brand_model: body.brand_model ?? null,
    serial_no: tracked && !sim ? (body.serial_no ?? null) : null,
    imei: ['MOBILE', 'TABLET'].includes(body.category) ? (body.imei ?? null) : null,
    specs: tracked && !sim ? (body.specs ?? null) : null,
    licence: ['LAPTOP', 'DESKTOP'].includes(body.category) ? (body.licence ?? null) : null,
    sim_number: sim ? (body.sim_number?.replace(/^\+91/, '') ?? null) : null,
    sim_operator: sim ? (body.sim_operator ?? null) : null,
    sim_plan_type: sim ? (body.sim_plan_type ?? null) : null,
    sim_plan_cost: sim && body.sim_plan_cost != null ? body.sim_plan_cost.toFixed(2) : null,
    sim_due_date: sim ? dateOnly(body.sim_due_date) : null,
    sim_in_asset_id: sim ? (body.sim_in_asset_id ?? null) : null,
    notes: body.notes ?? null,
  };
}

/** A friendly 409 for a serial / IMEI / SIM number that is already in the register. */
function duplicate(err: any) {
  if (err?.code !== 'P2002') return null;
  const target = String(err?.meta?.target || '');
  const what = target.includes('imei')
    ? 'IMEI'
    : target.includes('sim_number')
      ? 'SIM number'
      : target.includes('serial')
        ? 'serial number'
        : 'code';
  return { status: 409, message: `An asset with this ${what} is already in the register.` };
}

router.post(
  '/',
  authenticateToken,
  canManage,
  validateRequestBody(AssetSchema),
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const body = req.body as z.infer<typeof AssetSchema>;
      const ids = await getAccessibleCompanyIds(req.user!);
      const companyId = body.company_id || req.user!.companyId;
      if (!ids.includes(companyId))
        return res.status(403).json({ error: 'You do not have access to that company.' });
      const created = await p.$transaction(async (tx) => {
        const a = await tx.asset.create({
          data: {
            ...columns(body),
            asset_code: `TMP-${crypto.randomUUID().slice(0, 20)}`,
            company_id: companyId,
            status: 'IN_STOCK',
            created_by_id: req.user!.employeeId,
          },
        });
        return tx.asset.update({
          where: { id: a.id },
          data: { asset_code: `AST-${String(a.id).padStart(5, '0')}` },
        });
      });
      return res.status(201).json({ asset: view(created) });
    } catch (err) {
      const dup = duplicate(err);
      if (dup) return res.status(dup.status).json({ error: dup.message });
      next(err);
    }
  },
);

router.put(
  '/:id',
  authenticateToken,
  canManage,
  validateRequestBody(AssetSchema),
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const a = await loadAsset(req, Number(req.params.id) || 0);
      const body = req.body as z.infer<typeof AssetSchema>;
      if (a.holder_id && !isTracked(body.category)) {
        return res
          .status(409)
          .json({ error: 'Take it back first: only tracked items can be with a person.' });
      }
      const updated = await p.asset.update({ where: { id: a.id }, data: columns(body) });
      return res.json({ asset: view(updated) });
    } catch (err) {
      const dup = duplicate(err);
      if (dup) return res.status(dup.status).json({ error: dup.message });
      next(err);
    }
  },
);

const AssignSchema = z.object({
  employee_id: z.number().int().positive(),
  condition: z.enum(ASSET_CONDITIONS).optional(),
  note: optText(1000),
});

router.post(
  '/:id/assign',
  authenticateToken,
  canManage,
  validateRequestBody(AssignSchema),
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const a = await loadAsset(req, Number(req.params.id) || 0);
      const body = req.body as z.infer<typeof AssignSchema>;
      if (!isTracked(a.category))
        return res
          .status(400)
          .json({ error: 'Only systems, phones, SIMs and similar are given to a person.' });
      if (a.holder_id)
        return res.status(409).json({ error: 'Take it back from the current person first.' });
      if (['LOST', 'SCRAPPED'].includes(a.status))
        return res
          .status(409)
          .json({ error: `A ${a.status.toLowerCase()} asset cannot be given out.` });
      const ids = await getAccessibleCompanyIds(req.user!);
      const person = await p.employee.findFirst({
        where: { id: body.employee_id, status: 'ACTIVE', company_id: { in: ids } },
        select: { id: true },
      });
      if (!person) return res.status(404).json({ error: 'Employee not found or not active.' });
      await p.$transaction(async (tx) => {
        const taken = await tx.asset.updateMany({
          where: { id: a.id, holder_id: null },
          data: { holder_id: person.id, status: 'IN_USE' },
        });
        if (!taken.count) throw { status: 409, message: 'Someone just gave it out.' };
        await tx.assetAssignment.create({
          data: {
            asset_id: a.id,
            employee_id: person.id,
            assigned_by_id: req.user!.employeeId,
            condition_out: body.condition || 'GOOD',
            note_out: body.note,
          },
        });
      });
      return res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

const ReturnSchema = z.object({
  condition: z.enum(ASSET_CONDITIONS).optional(),
  note: optText(1000),
  /** LOST when the person cannot give it back. */
  outcome: z.enum(['RETURNED', 'LOST']).optional(),
});

router.post(
  '/:id/return',
  authenticateToken,
  canManage,
  validateRequestBody(ReturnSchema),
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const a = await loadAsset(req, Number(req.params.id) || 0);
      const body = req.body as z.infer<typeof ReturnSchema>;
      if (!a.holder_id) return res.status(409).json({ error: 'Nobody has this asset.' });
      const lost = body.outcome === 'LOST';
      if (lost && !body.note) return res.status(400).json({ error: 'Say what happened to it.' });
      const now = new Date();
      await p.$transaction([
        p.assetAssignment.updateMany({
          where: { asset_id: a.id, returned_at: null },
          data: {
            returned_at: now,
            returned_by_id: req.user!.employeeId,
            condition_in: lost ? null : body.condition || 'GOOD',
            note_in: body.note,
          },
        }),
        p.asset.update({
          where: { id: a.id },
          data: {
            holder_id: null,
            status: lost ? 'LOST' : body.condition === 'DAMAGED' ? 'UNDER_REPAIR' : 'IN_STOCK',
            status_note: lost ? body.note : a.status_note,
          },
        }),
      ]);
      return res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

const StatusSchema = z.object({
  status: z.enum(ASSET_STATUSES.map((s) => s.value) as [string, ...string[]]),
  note: optText(1000),
});

router.post(
  '/:id/status',
  authenticateToken,
  canManage,
  validateRequestBody(StatusSchema),
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const a = await loadAsset(req, Number(req.params.id) || 0);
      const body = req.body as z.infer<typeof StatusSchema>;
      if (a.holder_id && body.status !== 'IN_USE')
        return res.status(409).json({ error: 'Take it back from the person first.' });
      if (!a.holder_id && body.status === 'IN_USE' && isTracked(a.category))
        return res.status(400).json({ error: 'Give it to a person to mark it in use.' });
      if (['LOST', 'SCRAPPED'].includes(body.status) && !body.note)
        return res.status(400).json({ error: 'Give a reason.' });
      const updated = await p.asset.update({
        where: { id: a.id },
        data: { status: body.status, status_note: body.note ?? a.status_note },
      });
      return res.json({ asset: view(updated) });
    } catch (err) {
      next(err);
    }
  },
);

// ── the bill ───────────────────────────────────────────────────

router.post(
  '/:id/invoice',
  authenticateToken,
  canManage,
  (req, res, next) =>
    upload.single('file')(req, res, (err: any) =>
      err ? res.status(err.statusCode || 400).json({ error: err.message }) : next(),
    ),
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const a = await loadAsset(req, Number(req.params.id) || 0);
      const f = (req as any).file;
      if (!f) return res.status(400).json({ error: 'Choose the bill to attach.' });
      const stored = await getStorageService('asset-invoices').upload(
        f.buffer,
        f.originalname,
        f.mimetype,
      );
      await p.asset.update({ where: { id: a.id }, data: { invoice_path: stored } });
      if (a.invoice_path) {
        getStorageService('asset-invoices')
          .delete(a.invoice_path)
          .catch((e) => logger.warn('[Assets] old bill not removed: ' + (e as Error).message));
      }
      return res.status(201).json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  '/:id/invoice',
  authenticateToken,
  canRead,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const a = await loadAsset(req, Number(req.params.id) || 0);
      if (!a.invoice_path) return res.status(404).json({ error: 'No bill attached.' });
      const ext = path.extname(a.invoice_path.split('?')[0]).toLowerCase();
      const type =
        ext === '.pdf'
          ? 'application/pdf'
          : ext === '.png'
            ? 'image/png'
            : ext === '.webp'
              ? 'image/webp'
              : 'image/jpeg';
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, no-store');
      if (/^https?:\/\//i.test(a.invoice_path)) {
        const buffer = await getStorageService('asset-invoices').download(a.invoice_path);
        return res.type(type).send(buffer);
      }
      const filePath = path.resolve(UPLOAD_DIR, a.invoice_path.replace(/^\/?uploads\//, ''));
      if (!filePath.startsWith(path.resolve(UPLOAD_DIR) + path.sep) || !fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'The bill file is not on the server.' });
      }
      return res.type(type).sendFile(filePath);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
