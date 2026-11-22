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

export interface CpRequest extends Request {
  /** id is always the partner (the group); user is set when a partner's telecaller is signed in. */
  cp?: {
    id: number;
    company_id: number;
    employee_code: string;
    full_name: string | null;
    user: { id: number; full_name: string } | null;
  };
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
    const expired = () =>
      res.status(401).json({ error: 'Your session has expired. Please log in again.' });
    if (!e || e.status !== 'ACTIVE' || e.company_id !== payload.companyId || !isPartner(e.roles)) {
      return expired();
    }
    let user: { id: number; full_name: string } | null = null;
    if (payload.uid) {
      // A partner's telecaller: must still be active and belong to this partner.
      const u = await (p as any).cpUser.findUnique({ where: { id: payload.uid } });
      if (!u || !u.is_active || u.cp_id !== e.id || u.token_version !== payload.tv)
        return expired();
      user = { id: u.id, full_name: u.full_name };
    } else if (e.token_version !== payload.tv) {
      return expired();
    }
    req.cp = {
      id: e.id,
      company_id: e.company_id,
      employee_code: e.employee_code,
      full_name: e.full_name,
      user,
    };
    next();
  } catch (err) {
    next(err);
  }
};

/** Only the partner themselves (not one of their telecallers). */
export const requireOwner = (req: CpRequest, res: Response, next: NextFunction) =>
  req.cp?.user ? res.status(403).json({ error: 'Only the partner can do this.' }) : next();

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
    if (!e || !isPartner(e.roles)) {
      // Not a partner: it may be one of a partner's telecallers (their login is their phone number).
      const u = await (p as any).cpUser.findUnique({ where: { login_id: employee_code } });
      const owner = u
        ? await p.employee.findUnique({
            where: { id: u.cp_id },
            select: {
              id: true,
              company_id: true,
              status: true,
              roles: { select: { role: { select: { name: true } } } },
            },
          })
        : null;
      const userOk =
        !!u &&
        !!owner &&
        u.is_active &&
        owner.status === 'ACTIVE' &&
        isPartner(owner.roles) &&
        (await bcrypt.compare(password, u.password_hash));
      if (!userOk || !u || !owner) return res.status(401).json({ error: 'Invalid credentials' });
      return res.status(200).json({
        token: generateCpToken({
          employeeId: owner.id,
          companyId: owner.company_id,
          tv: u.token_version,
          uid: u.id,
        }),
        partner: { id: u.id, name: u.full_name, employee_code, role: 'TELECALLER' },
      });
    }
    const ok = e.status === 'ACTIVE' && (await bcrypt.compare(password, e.password_hash));
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
    return res.status(200).json({
      token: generateCpToken({ employeeId: e.id, companyId: e.company_id, tv: e.token_version }),
      partner: { id: e.id, name: e.full_name, employee_code, role: 'OWNER' },
    });
  } catch (error) {
    logger.error({ error }, 'Partner login error');
    return res.status(500).json({ error: 'Login failed' });
  }
});

router.get('/me', requireCp, (req: CpRequest, res) =>
  res.status(200).json({
    partner: {
      id: req.cp!.user ? req.cp!.user.id : req.cp!.id,
      name: req.cp!.user ? req.cp!.user.full_name : req.cp!.full_name,
      employee_code: req.cp!.employee_code,
      role: req.cp!.user ? 'TELECALLER' : 'OWNER',
      group_name: req.cp!.full_name,
    },
  }),
);

/** Phone-like digit runs (7+ digits) in texts written for staff are masked. */
export const maskPhones = (s: string) =>
  s.replace(/\+?\d[\d\s-]{5,}\d/g, (m) => (m.replace(/\D/g, '').length >= 7 ? '•••' : m));

router.get('/notifications', requireCp, requireOwner, async (req: CpRequest, res) => {
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
export const asUser = (req: CpRequest): TokenPayload => ({
  employeeId: req.cp!.id,
  employeeCode: req.cp!.employee_code,
  companyId: req.cp!.company_id,
  branchId: null,
  roles: [Roles.CHANNEL_PARTNER_EXTERNAL],
  permissions: [],
});

router.get('/drafts', requireCp, requireOwner, async (req: CpRequest, res, next) => {
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
  requireOwner,
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
  requireOwner,
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
