import { Router, Response , NextFunction} from 'express';
import { authenticateToken, AuthenticatedRequest, requirePermission } from '../middleware/auth';
import { Permissions } from '../shared';
import {
  SiteVisitCreateSchema,
  SiteVisitAcceptSchema,
  SiteVisitReassignSchema,
  SiteVisitEscalateSchema,
  SiteVisitRescheduleSchema,
  SiteVisitReconfirmSchema,
  SiteVisitCompleteSchema,
} from '../shared';
import { validateRequestBody } from '../middleware/validate';
import { SiteVisitService } from '../services/siteVisit.service';

const router = Router();

// GET /api/v1/site-visits - List site visits (role and company-aware)
router.get(
  '/',
  authenticateToken,
  requirePermission([Permissions.SITE_VISITS_READ]),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { status, leadId } = req.query;
      const filters = {
        status: status as string,
        leadId: leadId as string,
      };

      const visits = await SiteVisitService.listVisits(req.user!, filters);
      return res.status(200).json({ visits });
    } catch (error: any) {
      console.error('Fetch site visits error:', error);
      next(error);
    }
  }
);

// POST /api/v1/site-visits - Telecaller books site visit (→ REQUESTED → PENDING_ACCEPTANCE)
router.post(
  '/',
  authenticateToken,
  requirePermission([Permissions.SITE_VISITS_CREATE]),
  validateRequestBody(SiteVisitCreateSchema),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const booking = await SiteVisitService.bookVisit(req.user!, req.body);
      return res.status(201).json({
        message: `Site visit ${booking.booking_code} booked! Awaiting project PM acceptance.`,
        booking,
      });
    } catch (error: any) {
      console.error('Book site visit error:', error);
      next(error);
    }
  }
);

// POST /api/v1/site-visits/:id/accept - PM/Agent accepts the routed visit
router.post(
  '/:id/accept',
  authenticateToken,
  requirePermission([Permissions.SITE_VISITS_ASSIGN_AGENT]),
  validateRequestBody(SiteVisitAcceptSchema),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const visitId = parseInt(req.params.id, 10);
      if (isNaN(visitId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      const { notes } = req.body;
      const visit = await SiteVisitService.acceptVisit(req.user!, visitId, notes);
      return res.status(200).json({
        message: `Site visit ${visit.booking_code} accepted!`,
        visit,
      });
    } catch (error: any) {
      console.error('Accept site visit error:', error);
      next(error);
    }
  }
);

// POST /api/v1/site-visits/:id/reassign - Open reassignment chain (logged, §2)
router.post(
  '/:id/reassign',
  authenticateToken,
  requirePermission([Permissions.SITE_VISITS_ASSIGN_AGENT]),
  validateRequestBody(SiteVisitReassignSchema),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const visitId = parseInt(req.params.id, 10);
      if (isNaN(visitId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      const { to_employee_id, reason } = req.body;
      const visit = await SiteVisitService.reassignVisit(req.user!, visitId, to_employee_id, reason);
      return res.status(200).json({
        message: `Site visit ${visit.booking_code} reassigned.`,
        visit,
      });
    } catch (error: any) {
      console.error('Reassign site visit error:', error);
      next(error);
    }
  }
);

// POST /api/v1/site-visits/:id/escalate - No PM/Agent left → Marketing Director
router.post(
  '/:id/escalate',
  authenticateToken,
  requirePermission([Permissions.SITE_VISITS_ASSIGN_AGENT]),
  validateRequestBody(SiteVisitEscalateSchema),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const visitId = parseInt(req.params.id, 10);
      if (isNaN(visitId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      const { reason } = req.body;
      const visit = await SiteVisitService.escalateVisit(req.user!, visitId, reason);
      return res.status(200).json({
        message: `Site visit ${visit.booking_code} escalated to Marketing Director.`,
        visit,
      });
    } catch (error: any) {
      console.error('Escalate site visit error:', error);
      next(error);
    }
  }
);

// POST /api/v1/site-visits/:id/reconfirm-customer - Day-before reconfirmation call
router.post(
  '/:id/reconfirm-customer',
  authenticateToken,
  requirePermission([Permissions.SITE_VISITS_VERIFY]),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const visitId = parseInt(req.params.id, 10);
      if (isNaN(visitId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      const visit = await SiteVisitService.reconfirmCustomer(req.user!, visitId);
      return res.status(200).json({
        message: `Reconfirmation call initiated for ${visit.booking_code}.`,
        visit,
      });
    } catch (error: any) {
      console.error('Reconfirm-customer error:', error);
      next(error);
    }
  }
);

// POST /api/v1/site-visits/:id/reschedule - Customer requested reschedule (date/property)
router.post(
  '/:id/reschedule',
  authenticateToken,
  requirePermission([Permissions.SITE_VISITS_VERIFY]),
  validateRequestBody(SiteVisitRescheduleSchema),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const visitId = parseInt(req.params.id, 10);
      if (isNaN(visitId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      const visit = await SiteVisitService.rescheduleVisit(req.user!, visitId, req.body);
      return res.status(200).json({
        message: `Reschedule requested for ${visit.booking_code}. Awaiting PM reconfirmation.`,
        visit,
      });
    } catch (error: any) {
      console.error('Reschedule error:', error);
      next(error);
    }
  }
);

// POST /api/v1/site-visits/:id/pm-reconfirm - PM confirms or releases after reschedule
router.post(
  '/:id/pm-reconfirm',
  authenticateToken,
  requirePermission([Permissions.SITE_VISITS_ASSIGN_AGENT]),
  validateRequestBody(SiteVisitReconfirmSchema),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const visitId = parseInt(req.params.id, 10);
      if (isNaN(visitId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      const { release } = req.body;
      const visit = await SiteVisitService.pmReconfirm(req.user!, visitId, !!release);
      return res.status(200).json({
        message: release
          ? `Site visit ${visit.booking_code} released back to project PM for acceptance.`
          : `Site visit ${visit.booking_code} reconfirmed by PM.`,
        visit,
      });
    } catch (error: any) {
      console.error('PM reconfirm error:', error);
      next(error);
    }
  }
);

// POST /api/v1/site-visits/:id/confirm - PENDING_CUSTOMER_RECONFIRMATION / RESCHEDULE_REQUESTED → CONFIRMED
router.post(
  '/:id/confirm',
  authenticateToken,
  requirePermission([Permissions.SITE_VISITS_VERIFY]),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const visitId = parseInt(req.params.id, 10);
      if (isNaN(visitId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      const visit = await SiteVisitService.confirmVisit(req.user!, visitId);
      return res.status(200).json({
        message: `Site visit ${visit.booking_code} confirmed.`,
        visit,
      });
    } catch (error: any) {
      console.error('Confirm visit error:', error);
      next(error);
    }
  }
);

// POST /api/v1/site-visits/:id/start - CONFIRMED → ACTIVE (day-of)
router.post(
  '/:id/start',
  authenticateToken,
  requirePermission([Permissions.SITE_VISITS_COMPLETE]),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const visitId = parseInt(req.params.id, 10);
      if (isNaN(visitId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      const visit = await SiteVisitService.startVisit(req.user!, visitId);
      return res.status(200).json({
        message: `Site visit ${visit.booking_code} is now ACTIVE.`,
        visit,
      });
    } catch (error: any) {
      console.error('Start visit error:', error);
      next(error);
    }
  }
);

// POST /api/v1/site-visits/:id/complete - ACTIVE → COMPLETED with per-property outcomes (§2)
router.post(
  '/:id/complete',
  authenticateToken,
  requirePermission([Permissions.SITE_VISITS_COMPLETE]),
  validateRequestBody(SiteVisitCompleteSchema),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const visitId = parseInt(req.params.id, 10);
      if (isNaN(visitId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      const { outcomes, feedback_notes, proof_photo_url } = req.body;
      const visit = await SiteVisitService.completeVisit(req.user!, visitId, outcomes, feedback_notes, proof_photo_url);
      return res.status(200).json({
        message: `Site visit ${visit.booking_code} completed! Outcomes recorded.`,
        visit,
      });
    } catch (error: any) {
      console.error('Complete site visit error:', error);
      next(error);
    }
  }
);

// POST /api/v1/site-visits/:id/cancel - any active state → CANCELLED
router.post(
  '/:id/cancel',
  authenticateToken,
  requirePermission([Permissions.SITE_VISITS_COMPLETE]),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const visitId = parseInt(req.params.id, 10);
      if (isNaN(visitId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      const { reason } = req.body || {};
      const visit = await SiteVisitService.cancelVisit(req.user!, visitId, reason);
      return res.status(200).json({
        message: `Site visit ${visit.booking_code} cancelled.`,
        visit,
      });
    } catch (error: any) {
      console.error('Cancel site visit error:', error);
      next(error);
    }
  }
);

export default router;
