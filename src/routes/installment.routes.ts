import { Router } from 'express';
import { z } from 'zod';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { requireAuthz } from '../middleware/authz';
import { Permissions, InstallmentCreateSchema } from '../shared';
import { InstallmentService } from '../services/installment.service';
import { validateRequestBody } from '../middleware/validate';

const router = Router();

router.use(authenticateToken);

router.get(
  '/',
  requireAuthz(Permissions.BOOKINGS_READ as any),
  async (req: any, res, next) => {
    try {
      const bookingId = req.query.booking_id ? parseInt(req.query.booking_id as string, 10) : undefined;
      if (!bookingId) {
        return res.status(400).json({ error: 'booking_id query parameter is required' });
      }
      const installments = await InstallmentService.getInstallments(req.user, bookingId);
      res.json(installments);
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/',
  requireAuthz(Permissions.PAYMENTS_CREATE as any), // Only those who can create payments can create a schedule
  validateRequestBody(InstallmentCreateSchema),
  async (req: any, res, next) => {
    try {
      const dto = req.body;
      const installments = await InstallmentService.createInstallments(req.user, dto);
      res.status(201).json(installments);
    } catch (error) {
      next(error);
    }
  }
);

export default router;
