import { Router, Response } from 'express';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { requireAuthz } from '../middleware/authz';
import {
  ProjectCreateSchema,
  ProjectUpdateSchema,
  Permissions,
} from '../shared';
import { validateRequestBody } from '../middleware/validate';
import { ProjectService } from '../services/project.service';
import { prisma } from '../lib/prisma';
import { buildProjectScope } from '../authz/dataScope';

const router = Router();

const p = prisma;

// GET /api/v1/projects - List projects
router.get(
  '/',
  authenticateToken,
  requireAuthz(Permissions.PROJECTS_READ),
  async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { status } = req.query;
    const filters = {
      status: typeof status === 'string' ? status : undefined,
    };

    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 100);
    const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);

    const projects = await ProjectService.listProjects(req.user!, filters, limit, offset);
    return res.status(200).json({ projects, pagination: { limit, offset } });
  } catch (error: any) {
    console.error('Fetch projects error:', error);
    if (error.status) {
      return res.status(error.status).json({ error: error.message });
    }
    return res.status(500).json({ error: 'Failed to fetch projects' });
  }
});

// GET /api/v1/projects/:id - Get single project
router.get('/:id', authenticateToken, requireAuthz(Permissions.PROJECTS_READ, async (req) => {
  const projectId = parseInt(req.params.id, 10);
  return await p.project.findFirst({ where: { id: projectId } });
}), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const projectId = parseInt(req.params.id, 10);
    const project = await ProjectService.getProject(req.user!, projectId);
    return res.status(200).json({ project });
  } catch (error: any) {
    console.error('Fetch project error:', error);
    if (error.status) {
      return res.status(error.status).json({ error: error.message });
    }
    return res.status(500).json({ error: 'Failed to fetch project' });
  }
});

// POST /api/v1/projects - Create Project
router.post(
  '/',
  authenticateToken,
  requireAuthz(Permissions.PROJECTS_CREATE),
  validateRequestBody(ProjectCreateSchema),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const project = await ProjectService.createProject(req.user!, req.body);
      return res.status(201).json({
        message: 'Project created successfully',
        project,
      });
    } catch (error: any) {
      console.error('Create project error:', error);
      if (error.status) {
        return res.status(error.status).json({ error: error.message });
      }
      return res.status(500).json({ error: 'Failed to create project' });
    }
  }
);

// PUT /api/v1/projects/:id - Update Project
router.put(
  '/:id',
  authenticateToken,
  requireAuthz(Permissions.PROJECTS_UPDATE, async (req: AuthenticatedRequest) => {
    const projectId = parseInt(req.params.id, 10);
    // Use scoped query so out-of-scope projects return 404 (not 403), consistent with GET
    const scope = await buildProjectScope(req.user!);
    try {
      return await p.project.findFirst({ where: { id: projectId, ...scope } });
    } catch (e: any) {
      console.error('Prisma validation error payload:', e.message);
      throw e;
    }
  }),
  validateRequestBody(ProjectUpdateSchema),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const projectId = parseInt(req.params.id, 10);
      const project = await ProjectService.updateProject(req.user!, projectId, req.body);
      return res.status(200).json({
        message: 'Project updated successfully',
        project,
      });
    } catch (error: any) {
      console.error('Update project error:', error);
      if (error.status) {
        return res.status(error.status).json({ error: error.message });
      }
      return res.status(500).json({ error: 'Failed to update project' });
    }
  }
);

// DELETE /api/v1/projects/:id - Delete Project (Status transition)
router.delete(
  '/:id',
  authenticateToken,
  requireAuthz(Permissions.PROJECTS_DELETE, async (req: AuthenticatedRequest) => {
    const projectId = parseInt(req.params.id, 10);
    // Use scoped query so out-of-scope projects return 404 (not 403), consistent with GET
    const scope = await buildProjectScope(req.user!);
    try {
      return await p.project.findFirst({ where: { id: projectId, ...scope } });
    } catch (e: any) {
      console.error('Prisma validation error payload DELETE:', e.message);
      throw e;
    }
  }),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const projectId = parseInt(req.params.id, 10);
      const project = await ProjectService.deleteProject(req.user!, projectId);
      return res.status(200).json({
        message: 'Project deleted successfully',
        project,
      });
    } catch (error: any) {
      console.error('Delete project error:', error);
      if (error.status) {
        return res.status(error.status).json({ error: error.message });
      }
      return res.status(500).json({ error: 'Failed to delete project' });
    }
  }
);

export default router;
