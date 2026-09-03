import { Router } from 'express';
import { z } from 'zod';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { requireAuthz } from '../middleware/authz';
import { Permissions, BookingCreateSchema, BookingStatusUpdateSchema } from '../shared';
import { BookingService } from '../services/booking.service';
import { validateRequestBody } from '../middleware/validate';

const router = Router();

// Routes
router.use(authenticateToken);

router.get(
  '/',
  requireAuthz(Permissions.BOOKINGS_READ as any),
  async (req: any, res, next) => {
    try {
      const bookings = await BookingService.getBookings(req.user);
      res.json(bookings);
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/:id',
  requireAuthz(Permissions.BOOKINGS_READ as any),
  async (req: any, res, next) => {
    try {
      const booking = await BookingService.getBookingById(req.user, parseInt(req.params.id, 10));
      res.json(booking);
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/:id/handoff-status',
  requireAuthz(Permissions.BOOKINGS_READ as any),
  async (req: any, res, next) => {
    try {
      const handoff = await BookingService.getHandoffStatus(req.user, parseInt(req.params.id, 10));
      res.json(handoff);
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/',
  requireAuthz(Permissions.BOOKINGS_CREATE as any),
  validateRequestBody(BookingCreateSchema),
  async (req: any, res, next) => {
    try {
      const dto = req.body;
      const booking = await BookingService.createBooking(req.user, dto);
      res.status(201).json(booking);
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/:id/confirm',
  requireAuthz(Permissions.BOOKINGS_CONFIRM as any),
  async (req: any, res, next) => {
    try {
      const booking = await BookingService.confirmBooking(req.user, parseInt(req.params.id, 10));
      res.json(booking);
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/:id/cancel',
  requireAuthz(Permissions.BOOKINGS_CANCEL as any),
  async (req: any, res, next) => {
    try {
      const reason = req.body.reason || 'Booking cancelled';
      const booking = await BookingService.cancelBooking(req.user, parseInt(req.params.id, 10), reason);
      res.json(booking);
    } catch (error) {
      next(error);
    }
  }
);

router.put(
  '/:id/status',
  // Use BOOKINGS_UPDATE as base for this generic facade, 
  // the service layer enforces specific permissions (like CONFIRM/CANCEL)
  requireAuthz(Permissions.BOOKINGS_UPDATE as any), 
  validateRequestBody(BookingStatusUpdateSchema),
  async (req: any, res, next) => {
    try {
      const { status } = req.body;
      
      const booking = await BookingService.updateBookingStatus(req.user, parseInt(req.params.id, 10), status);
      res.json(booking);
    } catch (error) {
      next(error);
    }
  }
);

export default router;
