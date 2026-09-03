import { Router } from 'express';
import { z } from 'zod';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { requireAuthz } from '../middleware/authz';
import { Permissions, PaymentCreateSchema, PaymentStatusUpdateSchema } from '../shared';
import { PaymentService } from '../services/payment.service';
import { validateRequestBody } from '../middleware/validate';
import { BookingService } from '../services/booking.service';
import { prisma } from '../lib/prisma';

const router = Router();

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
  validateRequestBody(PaymentCreateSchema),
  async (req: any, res, next) => {
    try {
      const dto = req.body;
      
      // Dynamic lookup: ensure amount <= outstanding due on the booking
      const booking = await prisma.booking.findUnique({
        where: { id: dto.booking_id, company_id: req.user.companyId }
      });
      if (!booking) {
        return res.status(404).json({ error: 'Booking not found' });
      }
      
      if (dto.amount > booking.balance_amount) {
        return res.status(400).json({ error: `Payment amount (${dto.amount}) cannot exceed the outstanding balance (${booking.balance_amount})` });
      }

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
  validateRequestBody(PaymentStatusUpdateSchema),
  async (req: any, res, next) => {
    try {
      const { status } = req.body;
      const payment = await PaymentService.verifyPayment(req.user, parseInt(req.params.id, 10), status);
      res.json(payment);
    } catch (error) {
      next(error);
    }
  }
);

export default router;
