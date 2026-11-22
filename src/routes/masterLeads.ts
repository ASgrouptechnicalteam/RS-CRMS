import { Router, Response } from 'express';
import { z } from 'zod';
import { authenticateToken, AuthenticatedRequest, requireRole } from '../middleware/auth';
import { validateRequestBody } from '../middleware/validate';
import { logger } from '../utils/logger';
import { Roles } from '../shared';
import {
  addRows,
  assignDaily,
  createGroup,
  getOverview,
  listGroupContacts,
  moveBatchToGroup,
  MAX_ROWS_PER_REQUEST,
  startBatch,
  updateGroup,
} from '../services/lead/masterLeads';
import {
  listPeopleForReturn,
  previewReturn,
  returnToMaster,
} from '../services/lead/masterLeadReturn';

const router = Router();

// MD and Admin only. The overview is totals only; the one route that shows the people
// in a group (GET /groups/:id/contacts) is read only, paged, never an export, and each
// opening is written to the audit trail. A telecaller sees a number only once it is
// assigned to them.
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

const GroupCreateSchema = z.object({ name: z.string().min(2).max(80) });
router.post(
  '/groups',
  validateRequestBody(GroupCreateSchema),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      return res.status(201).json(await createGroup(req.user!, req.body));
    } catch (error) {
      return fail(res, error, 'add this group');
    }
  },
);

const GroupUpdateSchema = z.object({
  name: z.string().min(2).max(80).optional(),
  is_active: z.boolean().optional(),
});
router.patch(
  '/groups/:id',
  validateRequestBody(GroupUpdateSchema),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      return res.json(await updateGroup(req.user!, Number(req.params.id), req.body));
    } catch (error) {
      return fail(res, error, 'update this group');
    }
  },
);

router.get('/groups/:id/contacts', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const num = (v: unknown) => (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : undefined);
    return res.json(
      await listGroupContacts(req.user!, Number(req.params.id), {
        after: num(req.query.after),
        limit: num(req.query.limit),
        q: typeof req.query.q === 'string' ? req.query.q : undefined,
        status: typeof req.query.status === 'string' ? req.query.status : undefined,
      }),
    );
  } catch (error) {
    return fail(res, error, 'load this group');
  }
});

const MoveBatchSchema = z.object({ group_id: z.number().int().positive() });
// Repeat until `done` is true; each call moves one slice of the upload's numbers.
router.post(
  '/batches/:id/move',
  validateRequestBody(MoveBatchSchema),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      return res.json(await moveBatchToGroup(req.user!, Number(req.params.id), req.body.group_id));
    } catch (error) {
      return fail(res, error, 'move this upload');
    }
  },
);

const BatchSchema = z.object({
  group_id: z.number().int().positive().optional(),
  numbers_only: z.boolean().optional(),
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
  request_id: z.string().min(8).max(64),
  group_id: z.number().int().positive(),
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

router.get('/return/people', async (req: AuthenticatedRequest, res: Response) => {
  try {
    return res.json({ people: await listPeopleForReturn(req.user!) });
  } catch (error) {
    return fail(res, error, 'load this list');
  }
});

router.get('/return/preview/:employeeId', async (req: AuthenticatedRequest, res: Response) => {
  try {
    return res.json(await previewReturn(req.user!, Number(req.params.employeeId)));
  } catch (error) {
    return fail(res, error, 'count these leads');
  }
});

const ReturnSchema = z.object({
  employee_id: z.number().int().positive(),
  group_id: z.number().int().positive().optional(),
  keep_original: z.boolean(),
  reason: z.string().max(200).optional(),
  after_id: z.number().int().nonnegative().optional(),
});
router.post(
  '/return',
  validateRequestBody(ReturnSchema),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      return res.json(await returnToMaster(req.user!, req.body));
    } catch (error) {
      return fail(res, error, 'return these leads');
    }
  },
);

export default router;
