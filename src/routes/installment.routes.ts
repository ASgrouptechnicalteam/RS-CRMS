import { Router } from 'express';
import { z } from 'zod';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { requireAuthz } from '../middleware/authz';
import { Permissions } from '../shared';
import { InstallmentService } from '../services/installment.service';

const router = Router();

const CreateInstallmentSchema = z.object({
  booking_id: z.number().int().positive(),
  installment_number: z.number().int().positive(),
  expected_amount: z.number().positive(),
  due_date: z.string().datetime(),
  remarks: z.string().optional(),
});

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
  async (req: any, res, next) => {
    try {
      const dto = CreateInstallmentSchema.parse(req.body);
      const installment = await InstallmentService.createInstallment(req.user, dto.booking_id, dto);
      res.status(201).json(installment);
    } catch (error) {
      next(error);
    }
  }
);

export default router;
