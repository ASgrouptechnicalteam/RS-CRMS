import { EXPENSE_CATEGORIES } from '../shared';
import { Router, Response, NextFunction } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { hasEffectivePermission } from '../middleware/authz';
import { validateRequestBody } from '../middleware/validate';
import { Permissions, Roles } from '../shared';
import { getAccessibleCompanyIds } from '../authz/dataScope';
import { getStorageService, UPLOAD_DIR } from '../services/storage.service';
import { notifyEmployee } from '../utils/notifyEmployee';
import { getISTComponents } from '../utils/time';
import { IMPORT_MAX_ROWS, entryKey, readImportRows } from '../services/pettyCashImport';

/**
 * Petty cash and the monthly budget, per company (item 4, 2026-11-15).
 *  - The accountant enters expenses, top-ups and adjustments (no deletes; an
 *    adjustment with a reason corrects a mistake) and submits next month's
 *    budget; the MD approves or rejects it. MD, Admin and the Technical
 *    Manager can read. The MD switches company with ?company_id=.
 *  - A month's opening balance = everything before it, so it always equals the
 *    previous month's closing. Amounts are DECIMAL(12,2).
 */
const router = Router();
const p = prisma;

/** One fixed list (owner decision 8), shared with expense refunds. */
export const PETTY_CASH_CATEGORIES = EXPENSE_CATEGORIES;

const isAccountant = (req: AuthenticatedRequest) => req.user!.roles.includes(Roles.FINANCE);
const isMd = (req: AuthenticatedRequest) => req.user!.roles.includes(Roles.MD);
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const D = (v: Prisma.Decimal | number | string) => new Prisma.Decimal(v);
const money = (d: Prisma.Decimal) => Number(d.toFixed(2));

const monthStart = (month: string) => new Date(`${month}-01T00:00:00Z`);
const nextMonth = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
};
const thisMonth = () => getISTComponents(new Date()).dateString.slice(0, 7);

/** Signed effect on the balance. */
const signed = (type: string, amount: Prisma.Decimal) =>
  type === 'EXPENSE' ? amount.negated() : amount;

const guard =
  (perm: string, role: (r: AuthenticatedRequest) => boolean, what: string) =>
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!role(req) || !(await hasEffectivePermission(req.user!, perm))) {
      return res.status(403).json({ error: `Only ${what} can do this.` });
    }
    next();
  };
const canRead = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const roles = req.user!.roles;
  const allowed =
    roles.some((r) =>
      [Roles.FINANCE, Roles.MD, Roles.ADMIN, Roles.TECHNICAL_MANAGER].includes(r as any),
    ) && (await hasEffectivePermission(req.user!, Permissions.PETTY_CASH_READ));
  if (!allowed)
    return res.status(403).json({ error: 'Petty cash is for the accountant and the MD.' });
  next();
};

/** The company asked for, if this person may see it (default: their own). */
async function companyOf(req: AuthenticatedRequest, raw: unknown) {
  const ids = await getAccessibleCompanyIds(req.user!);
  const wanted = Number(raw) || req.user!.companyId;
  if (!ids.includes(wanted))
    throw { status: 403, message: 'You do not have access to that company.' };
  return wanted;
}

router.get('/meta', authenticateToken, canRead, async (req: AuthenticatedRequest, res) => {
  const ids = await getAccessibleCompanyIds(req.user!);
  const companies = await p.company.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
  return res.status(200).json({
    categories: PETTY_CASH_CATEGORIES,
    companies,
    can_manage: isAccountant(req),
    // The MD may add top-ups too (with their source), nothing else.
    can_top_up: isAccountant(req) || isMd(req),
    top_up_sources: TOP_UP_SOURCES,
    can_approve: isMd(req),
    this_month: thisMonth(),
  });
});

/** GET /petty-cash?company_id=&month=YYYY-MM: the month's book and its budget. */
router.get('/', authenticateToken, canRead, async (req: AuthenticatedRequest, res, next) => {
  try {
    const companyId = await companyOf(req, req.query.company_id);
    const month = MONTH.test(String(req.query.month || '')) ? String(req.query.month) : thisMonth();
    const start = monthStart(month);
    const end = monthStart(nextMonth(month));
    const [before, entries, budget] = await Promise.all([
      p.pettyCashEntry.groupBy({
        by: ['type'],
        where: { company_id: companyId, entry_date: { lt: start } },
        _sum: { amount: true },
      }),
      p.pettyCashEntry.findMany({
        where: { company_id: companyId, entry_date: { gte: start, lt: end } },
        orderBy: [{ entry_date: 'desc' }, { id: 'desc' }],
      }),
      p.monthlyBudget.findUnique({
        where: { company_id_month: { company_id: companyId, month } },
        include: { lines: { orderBy: { category: 'asc' } } },
      }),
    ]);
    const opening = before.reduce((n, g) => n.plus(signed(g.type, g._sum.amount || D(0))), D(0));
    let topUps = D(0);
    const bySource = new Map<string, Prisma.Decimal>();
    let expenses = D(0);
    let adjustments = D(0);
    const spent = new Map<string, Prisma.Decimal>();
    for (const e of entries) {
      if (e.type === 'TOP_UP') {
        topUps = topUps.plus(e.amount);
        const s = e.source || 'NOT_SAID';
        bySource.set(s, (bySource.get(s) || D(0)).plus(e.amount));
      } else if (e.type === 'ADJUSTMENT') adjustments = adjustments.plus(e.amount);
      else {
        expenses = expenses.plus(e.amount);
        const c = e.category || 'Other';
        spent.set(c, (spent.get(c) || D(0)).plus(e.amount));
      }
    }
    const closing = opening.plus(topUps).minus(expenses).plus(adjustments);
    const people = await p.employee.findMany({
      where: { id: { in: [...new Set(entries.map((e) => e.entered_by_id))] } },
      select: { id: true, full_name: true },
    });
    const nameOf = new Map(people.map((x) => [x.id, x.full_name]));
    const budgetOf = new Map((budget?.lines || []).map((l) => [l.category, l.amount]));
    return res.status(200).json({
      company_id: companyId,
      month,
      opening: money(opening),
      top_ups: money(topUps),
      top_ups_by_source: [...bySource.entries()].map(([source, amount]) => ({
        source,
        amount: money(amount),
      })),
      expenses: money(expenses),
      adjustments: money(adjustments),
      closing: money(closing),
      entries: entries.map((e) => ({
        id: e.id,
        entry_date: e.entry_date.toISOString().slice(0, 10),
        type: e.type,
        amount: money(e.amount),
        category: e.category,
        source: e.source,
        note: e.note,
        paid_to: e.paid_to,
        bill_no: e.bill_no,
        has_proof: !!e.proof_url,
        entered_by: nameOf.get(e.entered_by_id) || null,
      })),
      budget: budget
        ? {
            status: budget.status,
            note: budget.note,
            decision_note: budget.decision_note,
            submitted_at: budget.submitted_at,
            decided_at: budget.decided_at,
            total: money(budget.lines.reduce((n, l) => n.plus(l.amount), D(0))),
          }
        : null,
      // Budget against spend, for every category that has either.
      by_category: PETTY_CASH_CATEGORIES.filter((c) => budgetOf.has(c) || spent.has(c)).map(
        (c) => ({
          category: c,
          budget: budgetOf.has(c) ? money(budgetOf.get(c)!) : null,
          spent: money(spent.get(c) || D(0)),
        }),
      ),
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- entries

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = ['.jpg', '.jpeg', '.png', '.pdf', '.webp'].includes(
      path.extname(file.originalname).toLowerCase(),
    );
    if (ok) cb(null, true);
    else cb(new Error('Only images (JPG, PNG, WebP) and PDFs are allowed.'));
  },
});

const TOP_UP_SOURCES = ['BANK', 'UPI', 'CASH', 'CHEQUE', 'OTHER'] as const;

const EntrySchema = z
  .object({
    company_id: z.coerce.number().int().positive().optional(),
    entry_date: z.string().regex(DATE, 'Pick a date'),
    type: z.enum(['EXPENSE', 'TOP_UP', 'ADJUSTMENT']),
    // Positive for expenses and top-ups; an adjustment may be negative.
    amount: z.coerce.number().refine((n) => Number.isFinite(n) && n !== 0, 'Enter an amount'),
    category: z.enum(PETTY_CASH_CATEGORIES).optional(),
    source: z.enum(TOP_UP_SOURCES).optional(),
    note: z.string().trim().max(1000).optional(),
    paid_to: z.string().trim().max(120).optional(),
    bill_no: z.string().trim().max(60).optional(),
  })
  .refine((v) => v.type === 'ADJUSTMENT' || v.amount > 0, {
    message: 'The amount must be more than 0',
    path: ['amount'],
  })
  .refine((v) => v.type !== 'EXPENSE' || !!v.category, {
    message: 'Pick a category',
    path: ['category'],
  })
  .refine((v) => v.type !== 'TOP_UP' || !!v.source, {
    message: 'Say where the top-up came from (bank, UPI, cash...)',
    path: ['source'],
  })
  .refine((v) => v.type !== 'TOP_UP' || v.source !== 'OTHER' || (v.note || '').trim().length >= 3, {
    message: 'Say what the other source is (add a note)',
    path: ['note'],
  })
  .refine(
    (v) => (v.type !== 'ADJUSTMENT' && v.category !== 'Other') || (v.note || '').trim().length >= 3,
    { message: 'Say why (a note is needed for Other and for adjustments)', path: ['note'] },
  );

router.post(
  '/entries',
  authenticateToken,
  canRead,
  upload.single('proof') as any,
  validateRequestBody(EntrySchema),
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const body = req.body as z.infer<typeof EntrySchema>;
      // The accountant adds every kind of entry. The MD adds top-ups (money he
      // puts in), so a top-up always says where it came from (owner, 2026-11-16).
      const accountant =
        isAccountant(req) &&
        (await hasEffectivePermission(req.user!, Permissions.PETTY_CASH_MANAGE));
      const mdTopUp = isMd(req) && body.type === 'TOP_UP';
      if (!accountant && !mdTopUp) {
        return res.status(403).json({
          error: isMd(req)
            ? 'The MD can add top-ups. Expenses and adjustments are for the accountant.'
            : 'Only the accountant can do this.',
        });
      }
      const companyId = await companyOf(req, body.company_id);
      const today = getISTComponents(new Date()).dateString;
      if (body.entry_date > today)
        return res.status(400).json({ error: 'The date cannot be in the future.' });
      let proofUrl: string | null = null;
      if ((req as any).file) {
        const f = (req as any).file;
        proofUrl = await getStorageService('expense-proofs').upload(
          f.buffer,
          f.originalname,
          f.mimetype,
        );
      }
      const entry = await p.pettyCashEntry.create({
        data: {
          company_id: companyId,
          entry_date: new Date(`${body.entry_date}T00:00:00Z`),
          type: body.type,
          amount: D(body.amount.toFixed(2)),
          category: body.type === 'EXPENSE' ? body.category! : null,
          source: body.type === 'TOP_UP' ? body.source! : null,
          note: body.note || null,
          paid_to: body.paid_to || null,
          bill_no: body.bill_no || null,
          proof_url: proofUrl,
          entered_by_id: req.user!.employeeId,
        },
      });
      if (body.type === 'TOP_UP' && isMd(req)) {
        const accountants = await p.employee.findMany({
          where: {
            company_id: companyId,
            status: 'ACTIVE',
            roles: { some: { role: { name: Roles.FINANCE } } },
          },
          select: { id: true },
        });
        if (accountants.length) {
          await notifyEmployee(
            accountants.map((a) => a.id),
            {
              type: 'SYSTEM',
              title: 'Top-up added by the MD',
              message: `₹${money(entry.amount).toLocaleString('en-IN')} added to petty cash (${body.source}).`,
              link: '/petty-cash',
            },
          );
        }
      }
      return res.status(201).json({ entry: { id: entry.id } });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /petty-cash/import { company_id?, dry_run, rows }: spreadsheet rows (the CRM
 * template or a Tally export) as petty cash entries. A check run (dry_run) saves
 * nothing and says what would happen to every row; the real run saves only when no
 * row has an error, and skips rows already in the book (diary D28, 2026-11-21).
 */
router.post(
  '/import',
  authenticateToken,
  canRead,
  guard(Permissions.PETTY_CASH_MANAGE, isAccountant, 'the accountant'),
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const rows = Array.isArray(req.body?.rows)
        ? (req.body.rows as Record<string, unknown>[])
        : [];
      if (!rows.length) return res.status(400).json({ error: 'The file has no rows.' });
      if (rows.length > IMPORT_MAX_ROWS)
        return res.status(400).json({ error: `Import up to ${IMPORT_MAX_ROWS} rows at a time.` });
      const companyId = await companyOf(req, req.body?.company_id);
      const today = getISTComponents(new Date()).dateString;
      const parsed = readImportRows(rows, today);

      // Rows already in the book (same day, kind, amount, bill and payee) are skipped, so a file can be uploaded twice safely.
      const dates = parsed
        .filter((r) => r.entry)
        .map((r) => r.entry!.entry_date)
        .sort();
      const existing = dates.length
        ? await p.pettyCashEntry.findMany({
            where: {
              company_id: companyId,
              entry_date: {
                gte: new Date(`${dates[0]}T00:00:00Z`),
                lte: new Date(`${dates[dates.length - 1]}T00:00:00Z`),
              },
            },
            select: { entry_date: true, type: true, amount: true, bill_no: true, paid_to: true },
          })
        : [];
      const seen = new Set(
        existing.map((e) =>
          entryKey({
            entry_date: e.entry_date.toISOString().slice(0, 10),
            type: e.type,
            amount: money(e.amount),
            bill_no: e.bill_no,
            paid_to: e.paid_to,
          }),
        ),
      );
      const results = parsed.map((r) => {
        if (!r.entry) return { row: r.row, status: 'ERROR' as const, message: r.error! };
        const key = entryKey(r.entry);
        if (seen.has(key))
          return {
            row: r.row,
            status: 'SKIP' as const,
            message: 'Already in the book.',
            entry: r.entry,
          };
        seen.add(key);
        return { row: r.row, status: 'NEW' as const, entry: r.entry };
      });
      const fresh = results.filter((r) => r.status === 'NEW');
      const errors = results.filter((r) => r.status === 'ERROR').length;
      const total = (type: string) =>
        Math.round(
          fresh.filter((r) => r.entry!.type === type).reduce((a, r) => a + r.entry!.amount, 0) *
            100,
        ) / 100;
      const summary = {
        new: fresh.length,
        skipped: results.filter((r) => r.status === 'SKIP').length,
        errors,
        expenses: total('EXPENSE'),
        top_ups: total('TOP_UP'),
        adjustments: total('ADJUSTMENT'),
      };
      const dryRun = req.body?.dry_run !== false;
      if (dryRun || errors || !fresh.length) {
        return res.status(200).json({ saved: false, summary, rows: results });
      }
      await p.$transaction(
        fresh.map((r) =>
          p.pettyCashEntry.create({
            data: {
              company_id: companyId,
              entry_date: new Date(`${r.entry!.entry_date}T00:00:00Z`),
              type: r.entry!.type,
              amount: D(r.entry!.amount.toFixed(2)),
              category: r.entry!.category,
              source: r.entry!.source,
              note: r.entry!.note,
              paid_to: r.entry!.paid_to,
              bill_no: r.entry!.bill_no,
              entered_by_id: req.user!.employeeId,
            },
          }),
        ),
      );
      return res.status(201).json({ saved: true, summary, rows: results });
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  '/entries/:id/proof',
  authenticateToken,
  canRead,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const ids = await getAccessibleCompanyIds(req.user!);
      const e = await p.pettyCashEntry.findFirst({
        where: { id: Number(req.params.id) || 0, company_id: { in: ids } },
        select: { proof_url: true },
      });
      if (!e?.proof_url) return res.status(404).json({ error: 'No bill attached.' });
      if (/^https?:\/\//i.test(e.proof_url)) {
        const buffer = await getStorageService('expense-proofs').download(e.proof_url);
        res.type(path.extname(new URL(e.proof_url).pathname) || 'application/octet-stream');
        return res.send(buffer);
      }
      const filePath = path.resolve(UPLOAD_DIR, e.proof_url.replace(/^\/?uploads\//, ''));
      if (!filePath.startsWith(path.resolve(UPLOAD_DIR) + path.sep) || !fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'The bill file is not on the server.' });
      }
      return res.sendFile(filePath);
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------- budget

const BudgetSchema = z.object({
  company_id: z.number().int().positive().optional(),
  month: z.string().regex(MONTH, 'Pick a month'),
  note: z.string().trim().max(1000).optional(),
  lines: z
    .array(
      z.object({ category: z.enum(PETTY_CASH_CATEGORIES), amount: z.number().min(0).max(1e9) }),
    )
    .max(PETTY_CASH_CATEGORIES.length),
});

/** PUT /petty-cash/budget: save the draft (only while DRAFT or REJECTED). */
router.put(
  '/budget',
  authenticateToken,
  guard(Permissions.BUDGETS_SUBMIT, isAccountant, 'the accountant'),
  validateRequestBody(BudgetSchema),
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const body = req.body as z.infer<typeof BudgetSchema>;
      const companyId = await companyOf(req, body.company_id);
      const cur = await p.monthlyBudget.findUnique({
        where: { company_id_month: { company_id: companyId, month: body.month } },
      });
      if (cur && !['DRAFT', 'REJECTED'].includes(cur.status)) {
        return res
          .status(409)
          .json({ error: `This budget is already ${cur.status.toLowerCase()}.` });
      }
      const lines = body.lines.filter((l) => l.amount > 0);
      await p.$transaction(async (tx) => {
        const b = await tx.monthlyBudget.upsert({
          where: { company_id_month: { company_id: companyId, month: body.month } },
          create: { company_id: companyId, month: body.month, note: body.note || null },
          update: { status: 'DRAFT', note: body.note || null },
        });
        await tx.monthlyBudgetLine.deleteMany({ where: { budget_id: b.id } });
        if (lines.length) {
          await tx.monthlyBudgetLine.createMany({
            data: lines.map((l) => ({
              budget_id: b.id,
              category: l.category,
              amount: D(l.amount.toFixed(2)),
            })),
          });
        }
      });
      return res.status(200).json({ message: 'Budget saved.' });
    } catch (err) {
      next(err);
    }
  },
);

const MonthRef = z.object({
  company_id: z.number().int().positive().optional(),
  month: z.string().regex(MONTH),
});

router.post(
  '/budget/submit',
  authenticateToken,
  guard(Permissions.BUDGETS_SUBMIT, isAccountant, 'the accountant'),
  validateRequestBody(MonthRef),
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const companyId = await companyOf(req, req.body.company_id);
      const b = await p.monthlyBudget.findUnique({
        where: { company_id_month: { company_id: companyId, month: req.body.month } },
        include: { lines: true },
      });
      if (!b || b.lines.length === 0)
        return res.status(400).json({ error: 'Add at least one category first.' });
      if (!['DRAFT', 'REJECTED'].includes(b.status)) {
        return res.status(409).json({ error: `This budget is already ${b.status.toLowerCase()}.` });
      }
      await p.monthlyBudget.update({
        where: { id: b.id },
        data: {
          status: 'SUBMITTED',
          submitted_by_id: req.user!.employeeId,
          submitted_at: new Date(),
        },
      });
      const mds = await p.employee.findMany({
        where: {
          company_id: companyId,
          status: 'ACTIVE',
          roles: { some: { role: { name: Roles.MD } } },
        },
        select: { id: true },
      });
      const total = b.lines.reduce((n, l) => n.plus(l.amount), D(0));
      if (mds.length) {
        await notifyEmployee(
          mds.map((m) => m.id),
          {
            type: 'SYSTEM',
            title: `Budget for ${req.body.month} to approve`,
            message: `The accountant submitted ₹${money(total).toLocaleString('en-IN')} for ${req.body.month}.`,
            link: '/petty-cash',
          },
        );
      }
      return res.status(200).json({ message: 'Budget sent to the MD.' });
    } catch (err) {
      next(err);
    }
  },
);

const DecideSchema = MonthRef.extend({
  decision: z.enum(['APPROVE', 'REJECT']),
  note: z.string().trim().max(1000).optional(),
}).refine((v) => v.decision === 'APPROVE' || (v.note || '').length >= 3, {
  message: 'Say what to change',
  path: ['note'],
});

router.post(
  '/budget/decide',
  authenticateToken,
  guard(Permissions.BUDGETS_APPROVE, isMd, 'the MD'),
  validateRequestBody(DecideSchema),
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const companyId = await companyOf(req, req.body.company_id);
      const moved = await p.monthlyBudget.updateMany({
        where: { company_id: companyId, month: req.body.month, status: 'SUBMITTED' },
        data: {
          status: req.body.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
          decided_by_id: req.user!.employeeId,
          decided_at: new Date(),
          decision_note: req.body.note || null,
        },
      });
      if (!moved.count)
        return res.status(409).json({ error: 'There is no submitted budget to decide.' });
      const b = await p.monthlyBudget.findUnique({
        where: { company_id_month: { company_id: companyId, month: req.body.month } },
      });
      if (b?.submitted_by_id) {
        await notifyEmployee(b.submitted_by_id, {
          type: 'SYSTEM',
          title: `Budget for ${req.body.month} ${req.body.decision === 'APPROVE' ? 'approved' : 'sent back'}`,
          message:
            req.body.decision === 'APPROVE'
              ? 'The MD approved the budget.'
              : `The MD sent the budget back: ${req.body.note}`,
          link: '/petty-cash',
        });
      }
      return res.status(200).json({ message: 'Decision saved.' });
    } catch (err) {
      next(err);
    }
  },
);

router.use((err: any, _req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  if (err?.status && err?.message) return res.status(err.status).json({ error: err.message });
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.message });
  logger.error({ err }, 'Petty cash error');
  next(err);
});

export default router;
