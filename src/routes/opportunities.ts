import { logger } from '../utils/logger';
import { Router, Response , NextFunction} from 'express';
import { authenticateToken, AuthenticatedRequest, requirePermission } from '../middleware/auth';
import { Permissions } from '../shared';
import { OpportunityCreateSchema, OpportunityUpdateSchema } from '../shared';
import { validateRequestBody } from '../middleware/validate';
import { OpportunityService } from '../services/opportunity.service';

const router = Router();

// POST /api/v1/opportunities
router.post(
  '/',
  authenticateToken,
  requirePermission([Permissions.LEADS_UPDATE]), // Assuming lead management permissions govern opportunity creation
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const opportunity = await OpportunityService.createFromLead(req.user!, req.body);
      return res.status(201).json({
        message: 'Opportunity created successfully',
        opportunity,
      });
    } catch (error: any) {
      logger.error('Create opportunity error:', error);
      next(error);
    }
  }
);

// GET /api/v1/opportunities
router.get(
  '/',
  authenticateToken,
  requirePermission([Permissions.LEADS_READ]), 
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { stage, owner_id, project_id, property_id, date_from, date_to, expected_close_from, expected_close_to, sort_by, sort_order, limit, offset } = req.query;
      const filters = {
        stage: stage as string,
        owner_id: owner_id as string,
        project_id: project_id as string,
        property_id: property_id as string,
        date_from: date_from as string,
        date_to: date_to as string,
        expected_close_from: expected_close_from as string,
        expected_close_to: expected_close_to as string,
        sort_by: sort_by as string,
        sort_order: sort_order as string,
        limit: limit as string,
        offset: offset as string,
      };

      const result = await OpportunityService.getOpportunities(req.user!, filters);
      return res.status(200).json(result);
    } catch (error: any) {
      logger.error('Fetch opportunities error:', error);
      next(error);
    }
  }
);

// GET /api/v1/opportunities/pipeline-metrics
router.get(
  '/pipeline-metrics',
  authenticateToken,
  requirePermission([Permissions.LEADS_READ]),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const metrics = await OpportunityService.getPipelineMetrics(req.user!);
      return res.status(200).json({ metrics });
    } catch (error: any) {
      logger.error('Fetch pipeline metrics error:', error);
      next(error);
    }
  }
);

// GET /api/v1/opportunities/:id
router.get(
  '/:id',
  authenticateToken,
  requirePermission([Permissions.LEADS_READ]),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      if (isNaN(id)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      if (isNaN(id)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      if (isNaN(id)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      const opportunity = await OpportunityService.getOpportunityById(req.user!, id);
      return res.status(200).json({ opportunity });
    } catch (error: any) {
      logger.error('Fetch opportunity dossier error:', error);
      next(error);
    }
  }
);

// PATCH /api/v1/opportunities/:id
router.patch(
  '/:id',
  authenticateToken,
  requirePermission([Permissions.LEADS_UPDATE]),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      if (isNaN(id)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      if (isNaN(id)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      if (isNaN(id)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      const opportunity = await OpportunityService.updateOpportunity(req.user!, id, req.body);
      return res.status(200).json({
        message: 'Opportunity updated successfully',
        opportunity,
      });
    } catch (error: any) {
      logger.error('Update opportunity error:', error);
      next(error);
    }
  }
);


// POST /api/v1/opportunities/:id/convert-to-booking
router.post(
  '/:id/convert-to-booking',
  authenticateToken,
  requirePermission([Permissions.LEADS_UPDATE]), // Requires same update permission
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      if (isNaN(id)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      if (isNaN(id)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      if (isNaN(id)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      const booking = await OpportunityService.convertToBooking(req.user!, id, req.body);
      return res.status(201).json({
        message: 'Opportunity converted to Booking successfully',
        booking,
      });
    } catch (error: any) {
      logger.error('Convert opportunity to booking error:', error);
      next(error);
    }
  }
);

export default router;
