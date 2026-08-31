"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const authz_1 = require("../middleware/authz");
const shared_1 = require("../shared");
const validate_1 = require("../middleware/validate");
const project_service_1 = require("../services/project.service");
const prisma_1 = require("../lib/prisma");
const dataScope_1 = require("../authz/dataScope");
const router = (0, express_1.Router)();
const p = prisma_1.prisma;
// GET /api/v1/projects - List projects
router.get('/', auth_1.authenticateToken, (0, authz_1.requireAuthz)(shared_1.Permissions.PROJECTS_READ), async (req, res) => {
    try {
        const { status } = req.query;
        const filters = {
            status: typeof status === 'string' ? status : undefined,
        };
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 100);
        const offset = Math.max(parseInt(req.query.offset) || 0, 0);
        const projects = await project_service_1.ProjectService.listProjects(req.user, filters, limit, offset);
        return res.status(200).json({ projects, pagination: { limit, offset } });
    }
    catch (error) {
        console.error('Fetch projects error:', error);
        if (error.status) {
            return res.status(error.status).json({ error: error.message });
        }
        return res.status(500).json({ error: 'Failed to fetch projects' });
    }
});
// GET /api/v1/projects/:id - Get single project
router.get('/:id', auth_1.authenticateToken, (0, authz_1.requireAuthz)(shared_1.Permissions.PROJECTS_READ, async (req) => {
    const projectId = parseInt(req.params.id, 10);
    return await p.project.findFirst({ where: { id: projectId } });
}), async (req, res) => {
    try {
        const projectId = parseInt(req.params.id, 10);
        const project = await project_service_1.ProjectService.getProject(req.user, projectId);
        return res.status(200).json({ project });
    }
    catch (error) {
        console.error('Fetch project error:', error);
        if (error.status) {
            return res.status(error.status).json({ error: error.message });
        }
        return res.status(500).json({ error: 'Failed to fetch project' });
    }
});
// POST /api/v1/projects - Create Project
router.post('/', auth_1.authenticateToken, (0, authz_1.requireAuthz)(shared_1.Permissions.PROJECTS_CREATE), (0, validate_1.validateRequestBody)(shared_1.ProjectCreateSchema), async (req, res) => {
    try {
        const project = await project_service_1.ProjectService.createProject(req.user, req.body);
        return res.status(201).json({
            message: 'Project created successfully',
            project,
        });
    }
    catch (error) {
        console.error('Create project error:', error);
        if (error.status) {
            return res.status(error.status).json({ error: error.message });
        }
        return res.status(500).json({ error: 'Failed to create project' });
    }
});
// PUT /api/v1/projects/:id - Update Project
router.put('/:id', auth_1.authenticateToken, (0, authz_1.requireAuthz)(shared_1.Permissions.PROJECTS_UPDATE, async (req) => {
    const projectId = parseInt(req.params.id, 10);
    // Use scoped query so out-of-scope projects return 404 (not 403), consistent with GET
    const scope = await (0, dataScope_1.buildProjectScope)(req.user);
    try {
        return await p.project.findFirst({ where: { id: projectId, ...scope } });
    }
    catch (e) {
        console.error('Prisma validation error payload:', e.message);
        throw e;
    }
}), (0, validate_1.validateRequestBody)(shared_1.ProjectUpdateSchema), async (req, res) => {
    try {
        const projectId = parseInt(req.params.id, 10);
        const project = await project_service_1.ProjectService.updateProject(req.user, projectId, req.body);
        return res.status(200).json({
            message: 'Project updated successfully',
            project,
        });
    }
    catch (error) {
        console.error('Update project error:', error);
        if (error.status) {
            return res.status(error.status).json({ error: error.message });
        }
        return res.status(500).json({ error: 'Failed to update project' });
    }
});
// DELETE /api/v1/projects/:id - Delete Project (Status transition)
router.delete('/:id', auth_1.authenticateToken, (0, authz_1.requireAuthz)(shared_1.Permissions.PROJECTS_DELETE, async (req) => {
    const projectId = parseInt(req.params.id, 10);
    // Use scoped query so out-of-scope projects return 404 (not 403), consistent with GET
    const scope = await (0, dataScope_1.buildProjectScope)(req.user);
    try {
        return await p.project.findFirst({ where: { id: projectId, ...scope } });
    }
    catch (e) {
        console.error('Prisma validation error payload DELETE:', e.message);
        throw e;
    }
}), async (req, res) => {
    try {
        const projectId = parseInt(req.params.id, 10);
        const project = await project_service_1.ProjectService.deleteProject(req.user, projectId);
        return res.status(200).json({
            message: 'Project deleted successfully',
            project,
        });
    }
    catch (error) {
        console.error('Delete project error:', error);
        if (error.status) {
            return res.status(error.status).json({ error: error.message });
        }
        return res.status(500).json({ error: 'Failed to delete project' });
    }
});
exports.default = router;
