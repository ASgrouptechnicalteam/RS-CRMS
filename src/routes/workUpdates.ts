import { Roles } from '../shared';
import { Router, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { validateRequestBody } from '../middleware/validate';
import { getAccessibleCompanyIds } from '../authz/dataScope';
import { POST_KINDS } from './workLog';
import {
  WORK_UPDATE_KINDS,
  isWorkUpdateRole,
  istDay,
  minutesOf,
  pauseRunning,
  stopClock,
} from '../services/workUpdates';

/**
 * Work updates (owner, 2026-11-16), digital team only: Start a task when you
 * begin it, Done when it is finished. Mounted at /api/v1/work-updates.
 */
const router = Router();
const p = prisma;

const mineOnly = (req: AuthenticatedRequest, res: Response, next: () => void) => {
  // The digital team, and Admin (who sees every page, 2026-11-16). The
  // reminders and Team Today still follow the digital team only.
  if (!isWorkUpdateRole(req.user!.roles) && !req.user!.roles.includes(Roles.ADMIN)) {
    return res.status(403).json({ error: 'Work updates are for the digital team.' });
  }
  next();
};

type Row = Awaited<ReturnType<typeof p.workUpdate.findFirstOrThrow>>;

/** What the page shows for an update: minutes so far and what it is for. */
async function shape(rows: Row[]) {
  const projectIds = [...new Set(rows.map((r) => r.project_id).filter((x): x is number => !!x))];
  const propertyIds = [...new Set(rows.map((r) => r.property_id).filter((x): x is number => !!x))];
  const [projects, properties] = await Promise.all([
    projectIds.length
      ? p.project.findMany({ where: { id: { in: projectIds } }, select: { id: true, name: true } })
      : [],
    propertyIds.length
      ? p.property.findMany({
          where: { id: { in: propertyIds } },
          select: { id: true, title: true },
        })
      : [],
  ]);
  const now = new Date();
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    note: r.note,
    link: r.link,
    count: r.count,
    status: r.status,
    project: r.project_id
      ? { id: r.project_id, name: projects.find((x) => x.id === r.project_id)?.name || null }
      : null,
    property: r.property_id
      ? {
          id: r.property_id,
          name: properties.find((x) => x.id === r.property_id)?.title || null,
        }
      : null,
    started_at: r.started_at,
    resumed_at: r.resumed_at,
    finished_at: r.finished_at,
    updated_at: r.updated_at,
    minutes: minutesOf(r, now),
  }));
}
export type WorkUpdateView = Awaited<ReturnType<typeof shape>>[number];

const own = async (req: AuthenticatedRequest, res: Response) => {
  const id = Number(req.params.id);
  const row = Number.isInteger(id)
    ? await p.workUpdate.findFirst({ where: { id, employee_id: req.user!.employeeId } })
    : null;
  if (!row) {
    res.status(404).json({ error: 'Update not found' });
    return null;
  }
  return row;
};

// GET /work-updates/my - today's updates, plus anything still open from before.
router.get('/my', authenticateToken, mineOnly, async (req: AuthenticatedRequest, res) => {
  try {
    const { start } = istDay();
    const rows = await p.workUpdate.findMany({
      where: {
        employee_id: req.user!.employeeId,
        OR: [
          { started_at: { gte: start } },
          { finished_at: { gte: start } },
          { status: { in: ['WORKING', 'PAUSED'] } },
        ],
      },
      orderBy: { updated_at: 'desc' },
      take: 200,
    });
    return res.json({ updates: await shape(rows) });
  } catch (err) {
    logger.error('Work updates list failed', err);
    return res.status(500).json({ error: 'Could not load your updates.' });
  }
});

// GET /work-updates/targets?q= - projects and properties to link a task to.
router.get('/targets', authenticateToken, mineOnly, async (req: AuthenticatedRequest, res) => {
  const q = String(req.query.q || '')
    .trim()
    .slice(0, 60);
  if (q.length < 2) return res.json({ projects: [], properties: [] });
  const companyIds = await getAccessibleCompanyIds(req.user!);
  const [projects, properties] = await Promise.all([
    p.project.findMany({
      where: { company_id: { in: companyIds }, name: { contains: q } },
      select: { id: true, name: true },
      orderBy: { updated_at: 'desc' },
      take: 8,
    }),
    p.property.findMany({
      where: { company_id: { in: companyIds }, title: { contains: q } },
      select: { id: true, title: true },
      orderBy: { updated_at: 'desc' },
      take: 8,
    }),
  ]);
  return res.json({ projects, properties: properties.map((x) => ({ id: x.id, name: x.title })) });
});

const StartSchema = z.object({
  kind: z.enum(WORK_UPDATE_KINDS),
  title: z.string().trim().min(3, 'Say what the task is').max(255),
  note: z.string().trim().max(1000).optional(),
  project_id: z.number().int().positive().optional().nullable(),
  property_id: z.number().int().positive().optional().nullable(),
});

// POST /work-updates - start a task (whatever was running is paused).
router.post(
  '/',
  authenticateToken,
  mineOnly,
  validateRequestBody(StartSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const body = req.body as z.infer<typeof StartSchema>;
      const now = new Date();
      await pauseRunning(req.user!.employeeId, now);
      const row = await p.workUpdate.create({
        data: {
          employee_id: req.user!.employeeId,
          company_id: req.user!.companyId,
          kind: body.kind,
          title: body.title,
          note: body.note || null,
          project_id: body.project_id || null,
          property_id: body.property_id || null,
          status: 'WORKING',
          started_at: now,
          resumed_at: now,
        },
      });
      return res.status(201).json({ update: (await shape([row]))[0] });
    } catch (err) {
      logger.error('Work update start failed', err);
      return res.status(500).json({ error: 'Could not start the task.' });
    }
  },
);

// POST /work-updates/:id/pause
router.post('/:id/pause', authenticateToken, mineOnly, async (req: AuthenticatedRequest, res) => {
  const row = await own(req, res);
  if (!row) return;
  if (row.status !== 'WORKING') return res.status(409).json({ error: 'This task is not running.' });
  const updated = await p.workUpdate.update({
    where: { id: row.id },
    data: { status: 'PAUSED', worked_minutes: stopClock(row, new Date()), resumed_at: null },
  });
  return res.json({ update: (await shape([updated]))[0] });
});

// POST /work-updates/:id/resume (whatever else was running is paused).
router.post('/:id/resume', authenticateToken, mineOnly, async (req: AuthenticatedRequest, res) => {
  const row = await own(req, res);
  if (!row) return;
  if (row.status !== 'PAUSED') return res.status(409).json({ error: 'This task is not paused.' });
  const now = new Date();
  await pauseRunning(req.user!.employeeId, now, row.id);
  const updated = await p.workUpdate.update({
    where: { id: row.id },
    data: { status: 'WORKING', resumed_at: now },
  });
  return res.json({ update: (await shape([updated]))[0] });
});

const DoneSchema = z.object({
  link: z.string().trim().max(1000).optional().nullable(),
  count: z.number().int().min(1).max(500).optional(),
  note: z.string().trim().max(1000).optional().nullable(),
});

// POST /work-updates/:id/done - finished. Posts and reels need the link (the proof).
router.post(
  '/:id/done',
  authenticateToken,
  mineOnly,
  validateRequestBody(DoneSchema),
  async (req: AuthenticatedRequest, res) => {
    const row = await own(req, res);
    if (!row) return;
    if (row.status === 'DONE' || row.status === 'DROPPED') {
      return res.status(409).json({ error: 'This task is already closed.' });
    }
    const body = req.body as z.infer<typeof DoneSchema>;
    const link = body.link?.trim() || null;
    if (POST_KINDS.includes(row.kind) && !link) {
      return res.status(400).json({ error: 'Add the link to the post.' });
    }
    if (link && !/^https?:\/\/\S+$/i.test(link)) {
      return res.status(400).json({ error: 'The link must start with http:// or https://' });
    }
    const now = new Date();
    const updated = await p.workUpdate.update({
      where: { id: row.id },
      data: {
        status: 'DONE',
        finished_at: now,
        worked_minutes: row.status === 'WORKING' ? stopClock(row, now) : row.worked_minutes,
        resumed_at: null,
        link,
        count: body.count || 1,
        ...(body.note ? { note: body.note } : {}),
      },
    });
    return res.json({ update: (await shape([updated]))[0] });
  },
);

// POST /work-updates/:id/drop - stopped, not finished.
router.post('/:id/drop', authenticateToken, mineOnly, async (req: AuthenticatedRequest, res) => {
  const row = await own(req, res);
  if (!row) return;
  if (row.status === 'DONE' || row.status === 'DROPPED') {
    return res.status(409).json({ error: 'This task is already closed.' });
  }
  const now = new Date();
  const updated = await p.workUpdate.update({
    where: { id: row.id },
    data: {
      status: 'DROPPED',
      finished_at: now,
      worked_minutes: row.status === 'WORKING' ? stopClock(row, now) : row.worked_minutes,
      resumed_at: null,
    },
  });
  return res.json({ update: (await shape([updated]))[0] });
});

export { shape as shapeWorkUpdates };
export default router;
