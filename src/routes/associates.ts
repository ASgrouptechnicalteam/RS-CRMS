// Associates for the Channel Partner Manager, MD and Technical Manager.
// Mounted at /api/v1/associates. The associate's own app is a separate realm
// (routes/associatePortal.ts at /api/v1/associate) and never comes through here.
import { Router, Response } from 'express';
import { z } from 'zod';
import { authenticateToken, AuthenticatedRequest, requireRole } from '../middleware/auth';
import { validateRequestBody } from '../middleware/validate';
import { Roles } from '../shared';
import { logger } from '../utils/logger';
import {
  CHANNELS,
  OUTCOMES,
  PIPELINES,
  REPORTS,
  associatePortalEnabled,
  backfillLeads,
  createAssociate,
  getAssociate,
  getQueue,
  getSettings,
  listAssociates,
  listCpms,
  logFollowUp,
  reportLeadStatus,
  saveSettings,
  seesAllAssociates,
  setPortalPassword,
  updateAssociate,
  weeklyNumbers,
} from '../services/associate.service';
import { commitImport, previewImport } from '../services/associateImport';

const router = Router();
router.use(
  authenticateToken,
  requireRole([Roles.MD, Roles.ADMIN, Roles.TECHNICAL_MANAGER, Roles.CHANNEL_PARTNER_MANAGER]),
);

const handle =
  (fn: (req: AuthenticatedRequest) => Promise<unknown>, status = 200) =>
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      res.status(status).json(await fn(req));
    } catch (error: any) {
      if (error?.statusCode) return res.status(error.statusCode).json({ error: error.message });
      logger.error(`Associates ${req.method} ${req.path} error:`, error);
      res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
  };
const onlyAll = (req: AuthenticatedRequest) => {
  if (!seesAllAssociates(req.user!)) {
    const e: any = new Error('Only the MD or Technical Manager can change this.');
    e.statusCode = 403;
    throw e;
  }
};
const id = (v: string) => Number(v) || 0;

const text = (max: number) => z.string().trim().max(max);
const day = z.string().max(40);
const AssociateSchema = z.object({
  full_name: text(120).min(2, 'Enter the name'),
  phone: z.string().min(10, 'Enter a 10-digit mobile number').max(20),
  associate_code: text(40).nullable().optional(),
  email: z
    .string()
    .trim()
    .email('Enter a valid email')
    .max(254)
    .nullable()
    .optional()
    .or(z.literal('')),
  designation: text(80).nullable().optional(),
  upline_id: z.number().int().positive().nullable().optional(),
  owner_cpm_id: z.number().int().positive().nullable().optional(),
  pipeline: z.enum(PIPELINES).optional(),
  notes: text(2000).nullable().optional(),
  next_follow_up_at: day.nullable().optional(),
});
const FollowUpSchema = z.object({
  outcome: z.enum(OUTCOMES),
  channel: z.enum(CHANNELS).optional(),
  notes: text(1000).optional(),
  next_follow_up_at: day.nullable().optional(),
});
const ReportSchema = z.object({
  report: z.enum(Object.keys(REPORTS) as [string, ...string[]]),
  note: text(500).optional(),
});
const SettingsSchema = z.object({
  quiet_days: z.number().int().min(1).max(60).optional(),
  stale_days: z.number().int().min(1).max(90).optional(),
  escalate_days: z.number().int().min(1).max(180).optional(),
  dormant_days: z.number().int().min(7).max(365).optional(),
});
const ImportSchema = z.object({
  csv: z
    .string()
    .min(1)
    .max(5 * 1024 * 1024),
  source: z.enum(['PORTAL_EXPORT', 'SPREADSHEET']).optional(),
  owner_cpm_id: z.number().int().positive().nullable().optional(),
});
const PasswordSchema = z.object({ password: z.string().min(8).max(64).optional() });

router.get(
  '/',
  handle((req) =>
    listAssociates(req.user!, {
      search: typeof req.query.search === 'string' ? req.query.search : undefined,
      pipeline: typeof req.query.pipeline === 'string' ? req.query.pipeline : undefined,
      owner: typeof req.query.owner === 'string' ? req.query.owner : undefined,
      page: Number(req.query.page) || 1,
    }),
  ),
);
router.get(
  '/queue',
  handle((req) => getQueue(req.user!, { limit: Number(req.query.limit) || undefined })),
);
router.get(
  '/weekly',
  handle((req) =>
    weeklyNumbers(req.user!, typeof req.query.date === 'string' ? req.query.date : undefined),
  ),
);
router.get(
  '/cpms',
  handle((req) => listCpms(req.user!)),
);
router.get(
  '/settings',
  handle(async (req) => ({
    ...(await getSettings(req.user!)),
    portal_enabled: associatePortalEnabled(),
    can_edit: seesAllAssociates(req.user!),
  })),
);
router.put(
  '/settings',
  validateRequestBody(SettingsSchema),
  handle(async (req) => {
    onlyAll(req);
    return saveSettings(req.user!, req.body);
  }),
);
router.post(
  '/import/preview',
  validateRequestBody(ImportSchema),
  handle((req) => previewImport(req.user!, req.body.csv)),
);
router.post(
  '/import',
  validateRequestBody(ImportSchema),
  handle((req) => commitImport(req.user!, req.body.csv, req.body)),
);
router.post(
  '/backfill',
  validateRequestBody(z.object({ dry_run: z.boolean().optional() })),
  handle((req) => backfillLeads(req.user!, req.body.dry_run !== false)),
);
router.post(
  '/',
  validateRequestBody(AssociateSchema),
  handle((req) => createAssociate(req.user!, req.body), 201),
);
router.get(
  '/:id',
  handle((req) => getAssociate(req.user!, id(req.params.id))),
);
router.patch(
  '/:id',
  validateRequestBody(AssociateSchema.partial()),
  handle((req) => updateAssociate(req.user!, id(req.params.id), req.body)),
);
router.post(
  '/:id/follow-ups',
  validateRequestBody(FollowUpSchema),
  handle((req) => logFollowUp(req.user!, id(req.params.id), req.body), 201),
);
router.post(
  '/:id/leads/:leadId/report',
  validateRequestBody(ReportSchema),
  handle((req) =>
    reportLeadStatus(
      req.user!,
      id(req.params.id),
      id(req.params.leadId),
      req.body.report,
      req.body.note,
    ),
  ),
);
// The associate app login. Like the app itself, absent while it is switched off.
router.post(
  '/:id/portal-password',
  (req, res, next) =>
    associatePortalEnabled() ? next() : res.status(404).json({ error: 'API route not found' }),
  validateRequestBody(PasswordSchema),
  handle((req) => setPortalPassword(req.user!, id(req.params.id), req.body.password)),
);

export default router;
