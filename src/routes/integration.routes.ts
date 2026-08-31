import { Router } from 'express';
import { z } from 'zod';
import { authenticateServiceToken, authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { requireAuthz } from '../middleware/authz';
import { validateRequestBody } from '../middleware/validate';
import { PortalCallbackSchema, KycCallbackSchema, PaymentCallbackSchema, CustomerNotificationReadSchema, IntegrationMetricsQuerySchema, Permissions } from '../shared';
import { IntegrationService } from '../services/integration.service';
import { NotificationService } from '../services/notification.service';
import { CustomerPortalService } from '../services/customerPortal.service';

const router = Router();

// Portal → CRM callback endpoint.
// Authenticated via Service Bearer Secret (NOT a user JWT).
router.post(
  '/portal/callback',
  authenticateServiceToken,
  validateRequestBody(PortalCallbackSchema),
  async (req: any, res, next) => {
    try {
      const result = await IntegrationService.processPortalCallback(req.body);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }
);

// Portal → CRM KYC submission callback (Phase 11 Packet 3D).
// Authenticated via the same Service Bearer Secret (NOT a user JWT).
// The Portal may report ONLY "submitted" — verification authority stays in CRM.
router.post(
  '/portal/kyc-callback',
  authenticateServiceToken,
  validateRequestBody(KycCallbackSchema),
  async (req: any, res, next) => {
    try {
      const result = await IntegrationService.processKycCallback(req.body);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }
);

// Portal → CRM payment status callback (Phase 11 Packet 3F).
// Authenticated via the same Service Bearer Secret (NOT a user JWT).
// The Portal may report ONLY "completed"/"failed" — it may never claim
// SUCCESS/REFUNDED (CRM owns payment verification). The callback acks the
// outbound PAYMENT_STATUS_CHANGED event and marks the CRM payment SYNCED.
router.post(
  '/portal/payment-callback',
  authenticateServiceToken,
  validateRequestBody(PaymentCallbackSchema),
  async (req: any, res, next) => {
    try {
      const result = await IntegrationService.processPaymentCallback(req.body);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }
);

// Portal → CRM read-only customer-notifications API (Phase 11 Packet 3E).
// Authenticated via Service Bearer Secret (NOT a user JWT). The Portal may
// READ a customer's notifications; it can never create/update/delete them.
// Tenant + customer scoping is enforced in NotificationService.listForPortal.
router.get(
  '/portal/customer-notifications',
  authenticateServiceToken,
  async (req: any, res, next) => {
    try {
      const parsed = CustomerNotificationReadSchema.safeParse({
        company_id: req.query.company_id !== undefined ? Number(req.query.company_id) : undefined,
        crms_customer_id: req.query.crms_customer_id !== undefined ? Number(req.query.crms_customer_id) : undefined,
        page: req.query.page !== undefined ? Number(req.query.page) : undefined,
        limit: req.query.limit !== undefined ? Number(req.query.limit) : undefined,
      });
      if (!parsed.success) {
        return res.status(400).json({
          error: 'Invalid query parameters',
          details: parsed.error.errors.map((err) => ({
            field: err.path.join('.'),
            message: 'Invalid value',
          })),
        });
      }
      const result = await NotificationService.listForPortal(parsed.data);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }
);

// CRM-internal Portal/Integration metrics (Phase 11 Packet 3G).
// Authenticated via a user JWT (NOT the Portal service token) and authorized by
// ADMIN_SYSTEM_METRICS. Company-scoped to the authenticated user — the Portal
// must never read cross-tenant aggregate data.
router.get(
  '/metrics',
  authenticateToken,
  requireAuthz(Permissions.ADMIN_SYSTEM_METRICS),
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const parsed = IntegrationMetricsQuerySchema.safeParse({
        from: req.query.from,
        to: req.query.to,
        includeTimeseries: req.query.includeTimeseries,
      });
      if (!parsed.success) {
        return res.status(400).json({
          error: 'Invalid query parameters',
          details: parsed.error.errors.map((err) => ({
            field: err.path.join('.'),
            message: 'Invalid value',
          })),
        });
      }

      const companyId = req.user?.companyId ?? 1;
      const result = await IntegrationService.getPortalMetrics(companyId, parsed.data);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }
);

// §6 — Customer-portal provisioning endpoint (stub).
//
// The real portal contract is TBD (spec §8 item #3). This route exposes the
// provisioning call behind the standard integration surface. Today it delegates
// to CustomerPortalService.provisionStub (no-op + audit log); when the portal's
// real API is finalized, swap the stub for the real provisioner — the route
// shape stays unchanged.
router.post(
  '/customer-portal/provision',
  authenticateToken,
  requireAuthz(Permissions.MESSAGE_TEMPLATES_MANAGE),
  validateRequestBody(
    // Minimal contract: which booking/lead to provision for.
    z.object({
      lead_id: z.number().int(),
      customer_id: z.number().int().optional(),
    }),
  ),
  async (req: any, res, next) => {
    try {
      // Hand off to the (stub) provisioner. The internal BOOKED transition in
      // LeadService already calls this; this route is the explicit external trigger.
      const result = await CustomerPortalService.provisionStubForLead(req.user, req.body.lead_id);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  },
);

export default router;
