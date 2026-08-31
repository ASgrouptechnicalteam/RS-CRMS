import { Router, Response, NextFunction } from 'express';
import { authenticateToken, AuthenticatedRequest, requirePermission } from '../middleware/auth';
import { Permissions, MessageTemplateSchema } from '../shared';
import { validateRequestBody } from '../middleware/validate';
import { MessageTemplateService } from '../services/messageTemplate.service';

const router = Router();

// List all templates (active + inactive) for the admin editor.
router.get(
  '/',
  authenticateToken,
  requirePermission([Permissions.MESSAGE_TEMPLATES_MANAGE]),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const templates = await MessageTemplateService.list();
      return res.json(templates);
    } catch (error) {
      next(error);
    }
  },
);

// Resolve a single template to its substituted body_text (for a deep-link preview).
router.get(
  '/:key/resolve',
  authenticateToken,
  requirePermission([Permissions.MESSAGE_TEMPLATES_MANAGE]),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const key = req.params.key;
      const ctx = {
        customer_name: req.query.customer_name as string | undefined,
        property_name: req.query.property_name as string | undefined,
        pm_name: req.query.pm_name as string | undefined,
        visit_date: req.query.visit_date as string | undefined,
      };
      const resolved = await MessageTemplateService.resolve(key, ctx);
      if (!resolved) {
        return res.status(404).json({ error: 'No active template found for key' });
      }
      return res.json(resolved);
    } catch (error) {
      next(error);
    }
  },
);

// Upsert a template by key (admin editor save).
router.post(
  '/',
  authenticateToken,
  requirePermission([Permissions.MESSAGE_TEMPLATES_MANAGE]),
  validateRequestBody(MessageTemplateSchema),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const saved = await MessageTemplateService.upsert(req.body);
      return res.status(201).json(saved);
    } catch (error) {
      next(error);
    }
  },
);

// Activate / deactivate a template.
router.patch(
  '/:key/active',
  authenticateToken,
  requirePermission([Permissions.MESSAGE_TEMPLATES_MANAGE]),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const isActive = req.body?.is_active === true || req.body?.is_active === 'true';
      const updated = await MessageTemplateService.setActive(req.params.key, isActive);
      return res.json(updated);
    } catch (error) {
      next(error);
    }
  },
);

export default router;
