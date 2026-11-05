// Sharing details with customers. /public/:token is deliberately not signed in:
// a customer opens it from WhatsApp, and the random token is the only key
// (same shape as routes/feedback.ts). Everything else is for signed-in staff.
import { Router, Response } from 'express';
import { z } from 'zod';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { feedbackRateLimiter } from '../middleware/rateLimiter';
import { logger } from '../utils/logger';
import * as ShareService from '../services/share.service';

const router = Router();

const send = (res: Response, error: any, fallback: string) => {
  const status = error.statusCode || error.status;
  if (status) return res.status(status).json({ error: error.message });
  logger.error({ err: error }, `[share] ${fallback}`);
  return res.status(500).json({ error: fallback });
};

const KIND = z.enum(['PROJECT', 'UNIT', 'PROPERTY']);
const CreateSchema = z.object({
  kind: KIND,
  id: z.number().int().positive(),
  lead_id: z.number().int().positive().optional(),
  sections: z.object({
    overview: z.boolean(),
    price: z.boolean(),
    location: z.boolean(),
    brochure: z.boolean(),
    plans: z.boolean(),
    photos: z.boolean(),
  }),
});

router.get('/public/:token', feedbackRateLimiter, async (req, res: Response) => {
  try {
    const share = await ShareService.getPublicShare(req.params.token, {
      preview: req.query.preview === '1',
    });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ share });
  } catch (error) {
    return send(res, error, 'Failed to load these details');
  }
});

router.post('/public/:token/interested', feedbackRateLimiter, async (req, res: Response) => {
  try {
    return res.status(200).json(await ShareService.markInterested(req.params.token));
  } catch (error) {
    return send(res, error, 'Failed to send your request');
  }
});

router.get('/options', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    return res.status(200).json(await ShareService.getShareOptions(req.user!));
  } catch (error) {
    return send(res, error, 'Failed to load what can be shared');
  }
});

router.get('/details', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  const kind = KIND.safeParse(req.query.kind);
  const id = Number(req.query.id);
  if (!kind.success || !Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Choose what to share' });
  }
  try {
    return res.status(200).json(await ShareService.getShareDetails(req.user!, kind.data, id));
  } catch (error) {
    return send(res, error, 'Failed to load the details');
  }
});

router.get(
  '/leads/:leadId/links',
  authenticateToken,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      return res
        .status(200)
        .json(await ShareService.listLeadLinks(req.user!, parseInt(req.params.leadId, 10)));
    } catch (error) {
      return send(res, error, 'Failed to load the shared links');
    }
  },
);

router.post('/links', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  const parsed = CreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Choose what to share' });
  if (!Object.values(parsed.data.sections).some(Boolean)) {
    return res.status(400).json({ error: 'Tick at least one thing to share' });
  }
  try {
    return res
      .status(201)
      .json(await ShareService.createShareLink(req.user!, parsed.data, req.get('origin')));
  } catch (error) {
    return send(res, error, 'Failed to create the link');
  }
});

router.post(
  '/links/:id/revoke',
  authenticateToken,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      return res
        .status(200)
        .json(await ShareService.revokeShareLink(req.user!, parseInt(req.params.id, 10)));
    } catch (error) {
      return send(res, error, 'Failed to turn off the link');
    }
  },
);

export default router;
