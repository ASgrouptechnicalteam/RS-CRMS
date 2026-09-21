import { logger } from '../../utils/logger';
import { Router, Response } from 'express';
import { prisma } from '../../lib/prisma';
import { authenticateToken, AuthenticatedRequest, requireRole } from '../../middleware/auth';
import { validateRequestBody } from '../../middleware/validate';
import { Roles } from '../../shared';
import {
  CompanyCreateSchema,
  CompanyUpdateSchema,
  BranchCreateSchema,
  BranchUpdateSchema,
} from '../../shared/company';

const router = Router();
const p = prisma;

// Company/branch management has no code-level tenant it belongs to (it IS the
// tenant boundary), so this is restricted to Admin only — not MD, unlike most
// of the rest of the app's ALL_PERMISSIONS pairing of Admin with MD.
const requireAdminOnly = requireRole([Roles.ADMIN]);

// GET /api/v1/admin/companies - List every company with its branches, active or not
router.get(
  '/companies',
  authenticateToken,
  requireAdminOnly,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const companies = await p.company.findMany({
        include: { branches: { orderBy: { name: 'asc' } } },
        orderBy: { name: 'asc' },
      });
      return res.status(200).json({ companies });
    } catch (error) {
      logger.error('[Admin] List companies failed:', error);
      return res.status(500).json({ error: 'Failed to list companies' });
    }
  },
);

// POST /api/v1/admin/companies - Create a new company
router.post(
  '/companies',
  authenticateToken,
  requireAdminOnly,
  validateRequestBody(CompanyCreateSchema),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { name, code, property_type_group } = req.body;
      const company = await p.company.create({
        data: { name, code, property_type_group: property_type_group || undefined },
      });
      return res.status(201).json({ company });
    } catch (error: any) {
      logger.error('[Admin] Create company failed:', error);
      if (error.code === 'P2002') {
        return res.status(409).json({ error: 'A company with this code already exists' });
      }
      return res.status(500).json({ error: 'Failed to create company' });
    }
  },
);

// PATCH /api/v1/admin/companies/:id - Update a company's details
router.patch(
  '/companies/:id',
  authenticateToken,
  requireAdminOnly,
  validateRequestBody(CompanyUpdateSchema),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const companyId = parseInt(req.params.id, 10);
      if (isNaN(companyId)) return res.status(400).json({ error: 'Invalid ID' });
      const company = await p.company.update({
        where: { id: companyId },
        data: req.body,
      });
      return res.status(200).json({ company });
    } catch (error: any) {
      logger.error('[Admin] Update company failed:', error);
      if (error.code === 'P2002') {
        return res.status(409).json({ error: 'A company with this code already exists' });
      }
      if (error.code === 'P2025') {
        return res.status(404).json({ error: 'Company not found' });
      }
      return res.status(500).json({ error: 'Failed to update company' });
    }
  },
);

// POST /api/v1/admin/companies/:id/deactivate
router.post(
  '/companies/:id/deactivate',
  authenticateToken,
  requireAdminOnly,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const companyId = parseInt(req.params.id, 10);
      if (isNaN(companyId)) return res.status(400).json({ error: 'Invalid ID' });
      const company = await p.company.update({
        where: { id: companyId },
        data: { deleted_at: new Date() },
      });
      return res.status(200).json({ company });
    } catch (error: any) {
      logger.error('[Admin] Deactivate company failed:', error);
      if (error.code === 'P2025') {
        return res.status(404).json({ error: 'Company not found' });
      }
      return res.status(500).json({ error: 'Failed to deactivate company' });
    }
  },
);

// POST /api/v1/admin/companies/:id/reactivate
router.post(
  '/companies/:id/reactivate',
  authenticateToken,
  requireAdminOnly,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const companyId = parseInt(req.params.id, 10);
      if (isNaN(companyId)) return res.status(400).json({ error: 'Invalid ID' });
      const company = await p.company.update({
        where: { id: companyId },
        data: { deleted_at: null },
      });
      return res.status(200).json({ company });
    } catch (error: any) {
      logger.error('[Admin] Reactivate company failed:', error);
      if (error.code === 'P2025') {
        return res.status(404).json({ error: 'Company not found' });
      }
      return res.status(500).json({ error: 'Failed to reactivate company' });
    }
  },
);

// POST /api/v1/admin/branches - Create a new branch under a company
router.post(
  '/branches',
  authenticateToken,
  requireAdminOnly,
  validateRequestBody(BranchCreateSchema),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { company_id, name } = req.body;
      const company = await p.company.findUnique({ where: { id: company_id } });
      if (!company) return res.status(404).json({ error: 'Company not found' });
      const branch = await p.branch.create({ data: { company_id, name } });
      return res.status(201).json({ branch });
    } catch (error) {
      logger.error('[Admin] Create branch failed:', error);
      return res.status(500).json({ error: 'Failed to create branch' });
    }
  },
);

// PATCH /api/v1/admin/branches/:id - Update a branch's name
router.patch(
  '/branches/:id',
  authenticateToken,
  requireAdminOnly,
  validateRequestBody(BranchUpdateSchema),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const branchId = parseInt(req.params.id, 10);
      if (isNaN(branchId)) return res.status(400).json({ error: 'Invalid ID' });
      const branch = await p.branch.update({
        where: { id: branchId },
        data: req.body,
      });
      return res.status(200).json({ branch });
    } catch (error: any) {
      logger.error('[Admin] Update branch failed:', error);
      if (error.code === 'P2025') {
        return res.status(404).json({ error: 'Branch not found' });
      }
      return res.status(500).json({ error: 'Failed to update branch' });
    }
  },
);

// POST /api/v1/admin/branches/:id/deactivate
router.post(
  '/branches/:id/deactivate',
  authenticateToken,
  requireAdminOnly,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const branchId = parseInt(req.params.id, 10);
      if (isNaN(branchId)) return res.status(400).json({ error: 'Invalid ID' });
      const branch = await p.branch.update({
        where: { id: branchId },
        data: { deleted_at: new Date() },
      });
      return res.status(200).json({ branch });
    } catch (error: any) {
      logger.error('[Admin] Deactivate branch failed:', error);
      if (error.code === 'P2025') {
        return res.status(404).json({ error: 'Branch not found' });
      }
      return res.status(500).json({ error: 'Failed to deactivate branch' });
    }
  },
);

// POST /api/v1/admin/branches/:id/reactivate
router.post(
  '/branches/:id/reactivate',
  authenticateToken,
  requireAdminOnly,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const branchId = parseInt(req.params.id, 10);
      if (isNaN(branchId)) return res.status(400).json({ error: 'Invalid ID' });
      const branch = await p.branch.update({
        where: { id: branchId },
        data: { deleted_at: null },
      });
      return res.status(200).json({ branch });
    } catch (error: any) {
      logger.error('[Admin] Reactivate branch failed:', error);
      if (error.code === 'P2025') {
        return res.status(404).json({ error: 'Branch not found' });
      }
      return res.status(500).json({ error: 'Failed to reactivate branch' });
    }
  },
);

export default router;
