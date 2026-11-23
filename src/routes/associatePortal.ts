// The associate's own app (read only). Mounted at /api/v1/associate. Every
// route answers 404 unless ASSOCIATE_PORTAL_ENABLED=true. Its token is its own
// realm (utils/associateJwt.ts): an employee token never passes here, and an
// associate token never passes an employee route.
import { Router, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { validateRequestBody } from '../middleware/validate';
import { associatePortalSwitch, requireAssociate } from '../middleware/associateAuth';
import { clientIp } from '../middleware/rateLimiter';
import { AssociatePortalService } from '../services/associatePortal.service';
import {
  acceptReferral,
  addCustomer,
  declineReferral,
  referredToMe,
  updateReferral,
} from '../services/associatePortalWork';
import { logger } from '../utils/logger';

const router = Router();
router.use(associatePortalSwitch);

const phoneKey = (req: any) =>
  String(req.body?.phone || '')
    .replace(/\D/g, '')
    .slice(-10);

// Same limits as the customer portal: per address + number, and per number alone.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req: any) => `${clientIp(req)}:${phoneKey(req)}`,
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});
const phoneLockout = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  keyGenerator: (req: any) => `phone:${phoneKey(req)}`,
  skipSuccessfulRequests: true,
  message: { error: 'Too many wrong passwords for this number. Please try again in an hour.' },
  standardHeaders: true,
  legacyHeaders: false,
});
// Many associates share one mobile network address, so reads count per associate.
const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: (req: any) => `associate:${req.associate?.id ?? clientIp(req)}`,
  message: { error: 'Too many requests. Please wait a minute.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const LoginSchema = z.object({
  phone: z.string().min(10, 'Enter your mobile number').max(20),
  password: z.string().min(1, 'Enter your password').max(100),
  company_id: z.number().int().positive().optional(),
});
const ChangePasswordSchema = z.object({
  current_password: z.string().min(1).max(100),
  new_password: z.string().min(8, 'Use at least 8 characters').max(64),
});

const handle = (fn: (req: any) => Promise<unknown>) => async (req: any, res: Response) => {
  try {
    res.json(await fn(req));
  } catch (error: any) {
    if (error?.statusCode) return res.status(error.statusCode).json({ error: error.message });
    logger.error(`Associate app ${req.method} ${req.path} error:`, error);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};

router.get('/status', (_req, res) => res.json({ enabled: true }));
router.post(
  '/auth/login',
  loginLimiter,
  phoneLockout,
  validateRequestBody(LoginSchema),
  handle((req) =>
    AssociatePortalService.login(req.body.phone, req.body.password, req.body.company_id),
  ),
);
router.post(
  '/auth/change-password',
  loginLimiter,
  requireAssociate({ allowTemporary: true }),
  validateRequestBody(ChangePasswordSchema),
  handle((req) =>
    AssociatePortalService.changePassword(
      req.associate,
      req.body.current_password,
      req.body.new_password,
    ),
  ),
);
router.get(
  '/me',
  requireAssociate({ allowTemporary: true }),
  handle(async (req) => ({
    associate: {
      name: req.associate.full_name,
      code: req.associate.associate_code,
      mustChangePassword: req.associate.credential.force_password_change,
    },
  })),
);
router.get(
  '/home',
  requireAssociate(),
  readLimiter,
  handle((req) => AssociatePortalService.home(req.associate)),
);
router.get(
  '/leads',
  requireAssociate(),
  readLimiter,
  handle((req) => AssociatePortalService.leads(req.associate, Number(req.query.page) || 1)),
);
router.get(
  '/leads/:id',
  requireAssociate(),
  readLimiter,
  handle((req) => AssociatePortalService.lead(req.associate, Number(req.params.id) || 0)),
);
// ---- Work the leads we forward ("From RRH") and add a customer (2026-11-23) ----
const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: (req: any) => `associate-write:${req.associate?.id ?? clientIp(req)}`,
  message: { error: 'Too many requests. Please wait a minute.' },
  standardHeaders: true,
  legacyHeaders: false,
});
router.get(
  '/referred',
  requireAssociate(),
  readLimiter,
  handle((req) => referredToMe(req.associate)),
);
router.post(
  '/referred/:id/accept',
  requireAssociate(),
  writeLimiter,
  handle((req) => acceptReferral(req.associate, Number(req.params.id) || 0)),
);
router.post(
  '/referred/:id/decline',
  requireAssociate(),
  writeLimiter,
  validateRequestBody(z.object({ reason: z.string().trim().min(3, 'Say why').max(300) })),
  handle((req) => declineReferral(req.associate, Number(req.params.id) || 0, req.body.reason)),
);
router.post(
  '/referred/:id/update',
  requireAssociate(),
  writeLimiter,
  validateRequestBody(
    z.object({
      progress: z.enum(['CALLED', 'INTERESTED', 'VISIT_PLANNED', 'NOT_INTERESTED']),
      note: z.string().trim().max(500).optional(),
    }),
  ),
  handle((req) =>
    updateReferral(req.associate, Number(req.params.id) || 0, {
      progress: req.body.progress,
      note: req.body.note,
    }),
  ),
);
router.post(
  '/customers',
  requireAssociate(),
  writeLimiter,
  validateRequestBody(
    z.object({
      customer_name: z.string().trim().min(2, 'Enter the customer’s name').max(120),
      phone: z.string().min(10, 'Enter the customer’s mobile number').max(20),
      project_id: z.number().int().positive().nullable().optional(),
      note: z.string().trim().max(1000).optional(),
    }),
  ),
  handle((req) => addCustomer(req.associate, req.body)),
);
router.get(
  '/projects',
  requireAssociate(),
  readLimiter,
  handle((req) => AssociatePortalService.projects(req.associate)),
);

export default router;
