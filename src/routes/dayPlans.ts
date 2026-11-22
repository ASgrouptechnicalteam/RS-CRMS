import { Router, Response } from 'express';
import { z } from 'zod';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { validateRequestBody } from '../middleware/validate';
import { logger } from '../utils/logger';
import { prisma } from '../lib/prisma';
import { getISTComponents } from '../utils/time';
import {
  callCounts,
  getLogoutBlockers,
  getPlan,
  getTomorrow,
  saveTomorrow,
  setItemDone,
  setItemStatus,
  addUnplanned,
} from '../services/dayPlan.service';

const router = Router();
router.use(authenticateToken);

const fail = (res: Response, error: any, what: string) => {
  logger.error(`Day plan ${what} error:`, error);
  return res.status(500).json({ error: `Could not ${what}` });
};

router.get('/tomorrow', async (req: AuthenticatedRequest, res: Response) => {
  try {
    return res.json(await getTomorrow(req.user!.employeeId));
  } catch (error) {
    return fail(res, error, "load tomorrow's plan");
  }
});

const SaveSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string().max(64).optional(),
        text: z.string().trim().min(1).max(300),
        kind: z.enum(['NOTE', 'SITE_VISIT', 'TASK']).optional(),
        ref_id: z.number().int().nullable().optional(),
        time: z.string().max(20).nullable().optional(),
        carried_from: z.string().max(10).nullable().optional(),
      }),
    )
    .min(1, "Add at least one thing to tomorrow's plan")
    .max(50),
});
router.put(
  '/tomorrow',
  validateRequestBody(SaveSchema),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      return res.json(await saveTomorrow(req.user!.employeeId, req.body.items));
    } catch (error) {
      return fail(res, error, "save tomorrow's plan");
    }
  },
);

router.get('/today', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const date = getISTComponents(new Date()).dateString;
    return res.json(await getPlan(req.user!.employeeId, date));
  } catch (error) {
    return fail(res, error, "load today's plan");
  }
});

// Either { done } (the tick) or { status, note } (done differently, or not done and why).
const DoneSchema = z.union([
  z.object({ done: z.boolean() }),
  z.object({
    status: z.enum(['DONE', 'CHANGED', 'NOT_DONE', 'OPEN']),
    note: z.string().trim().max(300).optional(),
  }),
]);
router.patch(
  '/today/items/:itemId',
  validateRequestBody(DoneSchema),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const itemId = String(req.params.itemId);
      if ('done' in req.body) {
        return res.json(await setItemDone(req.user!.employeeId, itemId, req.body.done));
      }
      return res.json(await setItemStatus(req.user!.employeeId, itemId, req.body));
    } catch (error: any) {
      if (error?.statusCode === 400) return res.status(400).json({ error: error.message });
      return fail(res, error, 'update the plan');
    }
  },
);

router.post(
  '/today/unplanned',
  validateRequestBody(z.object({ text: z.string().trim().min(3).max(300) })),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      return res.status(201).json(await addUnplanned(req.user!.employeeId, req.body.text));
    } catch (error) {
      return fail(res, error, 'add the work');
    }
  },
);

router.get('/my-calls', async (req: AuthenticatedRequest, res: Response) => {
  try {
    return res.json(await callCounts(req.user!.employeeId));
  } catch (error) {
    return fail(res, error, 'load your calls');
  }
});

router.get('/logout-check', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const employee = await prisma.employee.findUnique({
      where: { id: req.user!.employeeId },
      select: { id: true, attendance_required: true },
    });
    if (!employee) return res.status(404).json({ error: 'Employee not found' });
    return res.json(await getLogoutBlockers(employee));
  } catch (error) {
    return fail(res, error, 'check logout');
  }
});

export default router;
