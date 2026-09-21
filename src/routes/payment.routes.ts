import { Router } from 'express';
import { z } from 'zod';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { requireAuthz } from '../middleware/authz';
import { Permissions } from '../shared';
import { PaymentService } from '../services/payment.service';

const router = Router();

// Zod schemas for validation
const RecordPaymentSchema = z.object({
  booking_id: z.number().int().positive(),
  installment_id: z.number().int().positive().optional(),
  amount: z.number().positive(),
  payment_method: z.enum(['CASH', 'CHEQUE', 'BANK_TRANSFER', 'ONLINE']),
  reference_number: z.string().optional().nullable(),
  notes: z.string().optional(),
});

const VerifyPaymentSchema = z.object({
  status: z.enum(['SUCCESS', 'FAILED', 'REFUNDED']),
});

// Routes
router.use(authenticateToken);

router.get(
  '/',
  requireAuthz(Permissions.PAYMENTS_READ as any),
  async (req: any, res, next) => {
    try {
      const bookingId = req.query.booking_id ? parseInt(req.query.booking_id as string, 10) : undefined;
      const payments = await PaymentService.getPayments(req.user, bookingId);
      res.json(payments);
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/',
  requireAuthz(Permissions.PAYMENTS_CREATE as any),
  async (req: any, res, next) => {
    try {
      const dto = RecordPaymentSchema.parse(req.body);
      const payment = await PaymentService.recordPayment(req.user, dto);
      res.status(201).json(payment);
    } catch (error) {
      next(error);
    }
  }
);

router.put(
  '/:id/status',
  requireAuthz(Permissions.PAYMENTS_UPDATE as any),
  async (req: any, res, next) => {
    try {
      const { status } = VerifyPaymentSchema.parse(req.body);
      const payment = await PaymentService.verifyPayment(req.user, parseInt(req.params.id, 10), status);
      res.json(payment);
    } catch (error) {
      next(error);
    }
  }
);

export default router;
