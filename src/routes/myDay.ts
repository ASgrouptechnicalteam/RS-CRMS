import { Router, Response } from 'express';
import { z } from 'zod';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { validateRequestBody } from '../middleware/validate';
import { logger } from '../utils/logger';
import { getChecklist, setTick } from '../services/myDayChecklist.service';

const router = Router();
router.use(authenticateToken);

const fail = (res: Response, error: any, what: string) => {
  if (error?.statusCode) return res.status(error.statusCode).json({ error: error.message });
  logger.error(`My Day ${what} error:`, error);
  return res.status(500).json({ error: `Could not ${what}` });
};

// The signed-in person's SOP checklist for today (IST).
router.get('/checklist', async (req: AuthenticatedRequest, res: Response) => {
  try {
    return res.json(await getChecklist(req.user!));
  } catch (error) {
    return fail(res, error, 'load your checklist');
  }
});

// Tick or untick one of your own manual items for today.
router.put(
  '/checklist/:key',
  validateRequestBody(z.object({ done: z.boolean() })),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      return res.json(await setTick(req.user!, String(req.params.key), req.body.done));
    } catch (error) {
      return fail(res, error, 'save your tick');
    }
  },
);

export default router;
