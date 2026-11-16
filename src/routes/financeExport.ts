import { Router, Response } from 'express';
import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';
import { authenticateToken, AuthenticatedRequest, requireRole } from '../middleware/auth';
import { Roles } from '../shared';
import { getAccessibleCompanyIds } from '../authz/dataScope';
import { collectionsView, syncExceptions } from '../services/collections';
import { getISTComponents } from '../utils/time';

/**
 * GET /api/v1/finance/export?kind=refunds|payments|installments&month=YYYY-MM
 * One month as a CSV file, for the accountant, the MD and Admin (item 6 #2,
 * 2026-11-15). Only the caller's companies; each row names its company.
 */
const router = Router();
const p = prisma;

/** A cell, quoted, with spreadsheet formulas neutralised (=, +, -, @ at the start). */
const cell = (v: unknown) => {
  let s = v === null || v === undefined ? '' : v instanceof Date ? istTime(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};
const istTime = (d: Date) =>
  new Date(d.getTime() + 330 * 60000).toISOString().slice(0, 16).replace('T', ' ');
const csv = (head: string[], rows: unknown[][]) =>
  '\uFEFF' + [head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';

const monthRange = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  const start = new Date(`${month}-01T00:00:00+05:30`);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return { start, end: new Date(`${next}-01T00:00:00+05:30`) };
};

router.get(
  '/export',
  authenticateToken,
  requireRole([Roles.FINANCE, Roles.MD, Roles.ADMIN]),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const kind = String(req.query.kind || '');
      const month = String(req.query.month || '');
      if (
        !['refunds', 'payments', 'installments'].includes(kind) ||
        !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)
      ) {
        return res
          .status(400)
          .json({ error: 'Pick refunds, payments or installments, and a month (YYYY-MM).' });
      }
      const { start, end } = monthRange(month);
      const companyIds = await getAccessibleCompanyIds(req.user!);
      const companies = new Map(
        (
          await p.company.findMany({
            where: { id: { in: companyIds } },
            select: { id: true, name: true },
          })
        ).map((c) => [c.id, c.name]),
      );
      let body = '';
      if (kind === 'refunds') {
        const rows = await p.expenseRefund.findMany({
          where: { company_id: { in: companyIds }, created_at: { gte: start, lt: end } },
          include: { employee: { select: { employee_code: true, full_name: true } } },
          orderBy: { created_at: 'desc' },
        });
        body = csv(
          [
            'Company',
            'Request',
            'Submitted (IST)',
            'Employee code',
            'Employee',
            'Category',
            'Spent on',
            'Bill no.',
            'Purpose',
            'Amount',
            'Status',
            'Accountant reviewed',
            'MD reviewed',
            'Refunded',
          ],
          rows.map((r) => [
            companies.get(r.company_id),
            r.id,
            r.created_at,
            r.employee.employee_code,
            r.employee.full_name,
            r.category,
            r.spend_date ? r.spend_date.toISOString().slice(0, 10) : '',
            r.bill_no,
            r.purpose,
            r.amount,
            r.status,
            r.accountant_reviewed_at,
            r.md_reviewed_at,
            r.refunded_at,
          ]),
        );
      } else if (kind === 'payments') {
        const rows = await p.payment.findMany({
          where: { company_id: { in: companyIds }, payment_date: { gte: start, lt: end } },
          include: {
            booking: {
              select: {
                booking_code: true,
                customer: { select: { first_name: true, last_name: true } },
              },
            },
            installment: { select: { installment_number: true } },
          },
          orderBy: { payment_date: 'desc' },
        });
        body = csv(
          [
            'Company',
            'Payment',
            'Date (IST)',
            'Booking',
            'Customer',
            'Installment',
            'Amount',
            'Method',
            'Reference',
            'Status',
            'Source',
          ],
          rows.map((r) => [
            companies.get(r.company_id),
            r.payment_code,
            r.payment_date,
            r.booking.booking_code,
            [r.booking.customer.first_name, r.booking.customer.last_name].filter(Boolean).join(' '),
            r.installment?.installment_number ?? '',
            r.amount,
            r.payment_method,
            r.reference_number,
            r.status,
            r.source,
          ]),
        );
      } else {
        const now = new Date();
        const rows = await p.installment.findMany({
          where: { booking: { company_id: { in: companyIds } }, due_date: { gte: start, lt: end } },
          include: {
            booking: {
              select: {
                company_id: true,
                booking_code: true,
                customer: { select: { first_name: true, last_name: true } },
              },
            },
          },
          orderBy: { due_date: 'desc' },
        });
        body = csv(
          [
            'Company',
            'Booking',
            'Customer',
            'Installment',
            'Due (IST)',
            'Expected',
            'Received',
            'Status',
            'Received on',
          ],
          rows.map((r) => [
            companies.get(r.booking.company_id),
            r.booking.booking_code,
            [r.booking.customer.first_name, r.booking.customer.last_name].filter(Boolean).join(' '),
            r.installment_number,
            r.due_date,
            r.expected_amount,
            r.received_amount,
            // Overdue is worked out on read, as on the installments page.
            ['PENDING', 'PARTIALLY_RECEIVED'].includes(r.status) && r.due_date < now
              ? 'OVERDUE'
              : r.status,
            r.received_date,
          ]),
        );
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${kind}-${month}.csv"`);
      return res.status(200).send(body);
    } catch (error) {
      logger.error({ error }, 'Finance export error');
      return res.status(500).json({ error: 'Failed to export' });
    }
  },
);

/** The caller's companies, or one of them when ?company_id= names it. */
const companiesFor = async (req: AuthenticatedRequest) => {
  const ids = await getAccessibleCompanyIds(req.user!);
  const one = Number(req.query.company_id);
  return one && ids.includes(one) ? [one] : ids;
};

// GET /api/v1/finance/collections?month=YYYY-MM&company_id=
// Overdue, due this week and received this month, in total and per project.
router.get(
  '/collections',
  authenticateToken,
  requireRole([Roles.FINANCE, Roles.MD, Roles.ADMIN]),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const month = String(req.query.month || getISTComponents(new Date()).dateString.slice(0, 7));
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
        return res.status(400).json({ error: 'Pick a month (YYYY-MM).' });
      }
      res.json(await collectionsView(await companiesFor(req), month));
    } catch (e) {
      logger.error('Collections view failed', e);
      res.status(500).json({ error: 'Could not load collections.' });
    }
  },
);

// GET /api/v1/finance/sync-exceptions?company_id=
// Payments stuck on the way to the customer portal for over a day, and refunds due.
router.get(
  '/sync-exceptions',
  authenticateToken,
  requireRole([Roles.FINANCE, Roles.MD, Roles.ADMIN]),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      res.json(await syncExceptions(await companiesFor(req)));
    } catch (e) {
      logger.error('Sync exceptions failed', e);
      res.status(500).json({ error: 'Could not load the exceptions.' });
    }
  },
);

export default router;
