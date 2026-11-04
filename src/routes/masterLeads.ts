import { Router, Response } from 'express';
import { z } from 'zod';
import { authenticateToken, AuthenticatedRequest, requireRole } from '../middleware/auth';
import { validateRequestBody } from '../middleware/validate';
import { logger } from '../utils/logger';
import { Roles } from '../shared';
import {
  addRows,
  assignDaily,
  getOverview,
  MAX_ROWS_PER_REQUEST,
  startBatch,
  takeBack,
} from '../services/lead/masterLeads';

const router = Router();

// Totals only: no route here lists or exports the numbers themselves. A telecaller
// sees a number only once it is assigned to them.
router.use(authenticateToken, requireRole([Roles.MD, Roles.ADMIN]));

const fail = (res: Response, error: any, what: string) => {
  if (error?.status || error?.statusCode) {
    return res.status(error.status || error.statusCode).json({ error: error.message });
  }
  logger.error(`Master data ${what} error:`, error);
  return res.status(500).json({ error: `Could not ${what}` });
};

router.get('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    return res.json(await getOverview(req.user!));
  } catch (error) {
    return fail(res, error, 'load master data');
  }
});

const BatchSchema = z.object({
  file_name: z.string().min(1).max(200),
  file_size: z.number().int().nonnegative().optional(),
  source: z.string().max(40).optional(),
  source_detail: z.string().max(80).optional(),
});
router.post(
  '/batches',
  validateRequestBody(BatchSchema),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const batch = await startBatch(req.user!, req.body);
      return res.status(201).json({ id: batch.id });
    } catch (error) {
      return fail(res, error, 'start the upload');
    }
  },
);

const RowsSchema = z.object({
  start_row: z.number().int().nonnegative(),
  rows: z.array(z.record(z.string(), z.any())).max(MAX_ROWS_PER_REQUEST),
  done: z.boolean().optional(),
});
router.post(
  '/batches/:id/rows',
  validateRequestBody(RowsSchema),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      return res.json(await addRows(req.user!, Number(req.params.id), req.body));
    } catch (error) {
      return fail(res, error, 'save these rows');
    }
  },
);

const AssignSchema = z.object({
  batch_id: z.number().int().positive().optional(),
  assignments: z
    .array(
      z.object({
        employee_id: z.number().int().positive(),
        count: z.number().int().positive(),
      }),
    )
    .min(1)
    .max(100),
});
router.post(
  '/assign',
  validateRequestBody(AssignSchema),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      return res.json(await assignDaily(req.user!, req.body));
    } catch (error) {
      return fail(res, error, 'assign these numbers');
    }
  },
);

router.post('/take-back/:employeeId', async (req: AuthenticatedRequest, res: Response) => {
  try {
    return res.json(await takeBack(req.user!, Number(req.params.employeeId)));
  } catch (error) {
    return fail(res, error, 'take these numbers back');
  }
});

export default router;
