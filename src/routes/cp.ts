import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';
import { Roles, ProjectDraftCreateSchema, PropertyDraftCreateSchema } from '../shared';
import { validateRequestBody } from '../middleware/validate';
import { clientIp } from '../middleware/rateLimiter';
import { generateCpToken, verifyCpToken } from '../utils/cpJwt';
import { DraftService } from '../services/draft.service';
import { TokenPayload } from '../utils/jwt';

/**
 * The external channel partner's own app (item 5, 2026-11-15), mounted at
 * /api/v1/cp. A partner is an Employee with the "Channel partner (external)"
 * role and no staff permissions; they sign in here and get a partner token
 * that no staff route accepts. They see only the visits they run, built field
 * by field (customer first name only, never a phone or address), their own
 * drafts, and their notifications with phone numbers masked.
 */
const router = Router();
const p = prisma;

interface CpRequest extends Request {
  cp?: { id: number; company_id: number; employee_code: string; full_name: string | null };
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req: any) =>
    `${clientIp(req)}:${String(req.body?.employee_code || '').slice(0, 40)}`,
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const isPartner = (roles: { role: { name: string } }[]) =>
  roles.some((r) => r.role.name === Roles.CHANNEL_PARTNER_EXTERNAL);

/** A valid partner token for an active partner whose sessions were not ended. */
export const requireCp = async (req: CpRequest, res: Response, next: NextFunction) => {
  const header = req.header('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return res.status(401).json({ error: 'Please log in' });
  let payload;
  try {
    payload = verifyCpToken(token);
  } catch {
    return res.status(401).json({ error: 'Your session has expired. Please log in again.' });
  }
  try {
    const e = await p.employee.findUnique({
      where: { id: payload.employeeId },
      select: {
        id: true,
        company_id: true,
        employee_code: true,
        full_name: true,
        status: true,
        token_version: true,
        roles: { select: { role: { select: { name: true } } } },
      },
    });
    if (
      !e ||
      e.status !== 'ACTIVE' ||
      e.company_id !== payload.companyId ||
      e.token_version !== payload.tv ||
      !isPartner(e.roles)
    ) {
      return res.status(401).json({ error: 'Your session has expired. Please log in again.' });
    }
    req.cp = {
      id: e.id,
      company_id: e.company_id,
      employee_code: e.employee_code,
      full_name: e.full_name,
    };
    next();
  } catch (err) {
    next(err);
  }
};

// POST /cp/auth/login { employee_code, password }
const LoginSchema = z.object({
  // Same as the staff sign-in: IDs are stored in capitals (RRH-CP-001).
  employee_code: z.string().trim().toUpperCase().min(1).max(40),
  password: z.string().min(1).max(200),
});
router.post('/auth/login', loginLimiter, validateRequestBody(LoginSchema), async (req, res) => {
  try {
    const { employee_code, password } = req.body;
    const e = await p.employee.findUnique({
      where: { employee_code },
      select: {
        id: true,
        company_id: true,
        full_name: true,
        status: true,
        password_hash: true,
        token_version: true,
        roles: { select: { role: { select: { name: true } } } },
      },
    });
    const ok =
      !!e &&
      e.status === 'ACTIVE' &&
      isPartner(e.roles) &&
      (await bcrypt.compare(password, e.password_hash));
    if (!ok || !e) return res.status(401).json({ error: 'Invalid credentials' });
    return res.status(200).json({
      token: generateCpToken({ employeeId: e.id, companyId: e.company_id, tv: e.token_version }),
      partner: { id: e.id, name: e.full_name, employee_code },
    });
  } catch (error) {
    logger.error({ error }, 'Partner login error');
    return res.status(500).json({ error: 'Login failed' });
  }
});

router.get('/me', requireCp, (req: CpRequest, res) =>
  res.status(200).json({
    partner: { id: req.cp!.id, name: req.cp!.full_name, employee_code: req.cp!.employee_code },
  }),
);

const firstName = (name?: string | null) => (name || '').trim().split(/\s+/)[0] || 'Customer';

const visitSelect = {
  id: true,
  booking_code: true,
  scheduled_date: true,
  status: true,
  lead: { select: { customer_name: true } },
  project: { select: { name: true, location: true, city: true, maps_link: true } },
  property: { select: { title: true, location: true, city: true } },
  project_manager: { select: { full_name: true, phone: true } },
} as const;

/** The partner's view of a visit: built field by field, never by spreading a record. */
const toCpVisit = (v: any) => ({
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
  pm: v.project_manager
    ? { name: v.project_manager.full_name, phone: v.project_manager.phone }
    : null,
});

// GET /cp/visits?scope=upcoming|past
router.get('/visits', requireCp, async (req: CpRequest, res) => {
  try {
    const past = req.query.scope === 'past';
    const now = new Date();
    const visits = await p.siteVisitBooking.findMany({
      where: {
        assigned_agent_id: req.cp!.id,
        lead: { company_id: req.cp!.company_id },
        ...(past
          ? {
              OR: [{ scheduled_date: { lt: now } }, { status: { in: ['COMPLETED', 'CANCELLED'] } }],
            }
          : {
              scheduled_date: { gte: new Date(now.getTime() - 12 * 3600e3) },
              status: { notIn: ['COMPLETED', 'CANCELLED'] },
            }),
      },
      select: visitSelect,
      orderBy: { scheduled_date: past ? 'desc' : 'asc' },
      take: 100,
    });
    return res.status(200).json({ visits: visits.map(toCpVisit) });
  } catch (error) {
    logger.error({ error }, 'Partner visits error');
    return res.status(500).json({ error: 'Failed to load visits' });
  }
});

router.get('/visits/:id', requireCp, async (req: CpRequest, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid ID format' });
  const v = await p.siteVisitBooking.findFirst({
    where: { id, assigned_agent_id: req.cp!.id, lead: { company_id: req.cp!.company_id } },
    select: visitSelect,
  });
  if (!v) return res.status(404).json({ error: 'Visit not found' });
  return res.status(200).json({ visit: toCpVisit(v) });
});

/** Phone-like digit runs (7+ digits) in texts written for staff are masked. */
export const maskPhones = (s: string) =>
  s.replace(/\+?\d[\d\s-]{5,}\d/g, (m) => (m.replace(/\D/g, '').length >= 7 ? '•••' : m));

router.get('/notifications', requireCp, async (req: CpRequest, res) => {
  const rows = await p.notification.findMany({
    where: { employee_id: req.cp!.id, is_dismissed: false },
    orderBy: { created_at: 'desc' },
    take: 50,
    select: { id: true, title: true, message: true, is_read: true, created_at: true },
  });
  return res.status(200).json({
    notifications: rows.map((n) => ({
      ...n,
      title: maskPhones(n.title),
      message: maskPhones(n.message),
    })),
  });
});

/** The draft service works on a staff-like identity; a partner has no permissions. */
const asUser = (req: CpRequest): TokenPayload => ({
  employeeId: req.cp!.id,
  employeeCode: req.cp!.employee_code,
  companyId: req.cp!.company_id,
  branchId: null,
  roles: [Roles.CHANNEL_PARTNER_EXTERNAL],
  permissions: [],
});

router.get('/drafts', requireCp, async (req: CpRequest, res, next) => {
  try {
    const { drafts, total } = await DraftService.list(asUser(req), { limit: 50, offset: 0 });
    return res.status(200).json({ drafts, total });
  } catch (err) {
    next(err);
  }
});
router.post(
  '/drafts/property',
  requireCp,
  validateRequestBody(PropertyDraftCreateSchema),
  async (req: CpRequest, res, next) => {
    try {
      return res.status(201).json({ draft: await DraftService.create(asUser(req), req.body) });
    } catch (err) {
      next(err);
    }
  },
);
router.post(
  '/drafts/project',
  requireCp,
  validateRequestBody(ProjectDraftCreateSchema),
  async (req: CpRequest, res, next) => {
    try {
      return res.status(201).json({ draft: await DraftService.create(asUser(req), req.body) });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
