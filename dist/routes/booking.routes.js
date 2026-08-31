"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const auth_1 = require("../middleware/auth");
const authz_1 = require("../middleware/authz");
const shared_1 = require("../shared");
const booking_service_1 = require("../services/booking.service");
const router = (0, express_1.Router)();
// Zod schemas for validation
const CreateBookingSchema = zod_1.z.object({
    customer_id: zod_1.z.number().int().positive(),
    property_id: zod_1.z.number().int().positive(),
    agreed_price: zod_1.z.number().positive(),
    booking_amount: zod_1.z.number().positive(),
    notes: zod_1.z.string().optional(),
    assigned_employee_id: zod_1.z.number().int().positive().optional(),
});
const UpdateBookingStatusSchema = zod_1.z.object({
    status: zod_1.z.enum(['TOKEN_RECEIVED', 'CONFIRMED', 'CANCELLED', 'COMPLETED']),
});
// Routes
router.use(auth_1.authenticateToken);
router.get('/', (0, authz_1.requireAuthz)(shared_1.Permissions.BOOKINGS_READ), async (req, res, next) => {
    try {
        const bookings = await booking_service_1.BookingService.getBookings(req.user);
        res.json(bookings);
    }
    catch (error) {
        next(error);
    }
});
router.get('/:id', (0, authz_1.requireAuthz)(shared_1.Permissions.BOOKINGS_READ), async (req, res, next) => {
    try {
        const booking = await booking_service_1.BookingService.getBookingById(req.user, parseInt(req.params.id, 10));
        res.json(booking);
    }
    catch (error) {
        next(error);
    }
});
router.get('/:id/handoff-status', (0, authz_1.requireAuthz)(shared_1.Permissions.BOOKINGS_READ), async (req, res, next) => {
    try {
        const handoff = await booking_service_1.BookingService.getHandoffStatus(req.user, parseInt(req.params.id, 10));
        res.json(handoff);
    }
    catch (error) {
        next(error);
    }
});
router.post('/', (0, authz_1.requireAuthz)(shared_1.Permissions.BOOKINGS_CREATE), async (req, res, next) => {
    try {
        const dto = CreateBookingSchema.parse(req.body);
        const booking = await booking_service_1.BookingService.createBooking(req.user, dto);
        res.status(201).json(booking);
    }
    catch (error) {
        next(error);
    }
});
router.post('/:id/confirm', (0, authz_1.requireAuthz)(shared_1.Permissions.BOOKINGS_CONFIRM), async (req, res, next) => {
    try {
        const booking = await booking_service_1.BookingService.confirmBooking(req.user, parseInt(req.params.id, 10));
        res.json(booking);
    }
    catch (error) {
        next(error);
    }
});
router.post('/:id/cancel', (0, authz_1.requireAuthz)(shared_1.Permissions.BOOKINGS_CANCEL), async (req, res, next) => {
    try {
        const reason = req.body.reason || 'Booking cancelled';
        const booking = await booking_service_1.BookingService.cancelBooking(req.user, parseInt(req.params.id, 10), reason);
        res.json(booking);
    }
    catch (error) {
        next(error);
    }
});
router.put('/:id/status', 
// Use BOOKINGS_UPDATE as base for this generic facade, 
// the service layer enforces specific permissions (like CONFIRM/CANCEL)
(0, authz_1.requireAuthz)(shared_1.Permissions.BOOKINGS_UPDATE), async (req, res, next) => {
    try {
        const { status } = UpdateBookingStatusSchema.parse(req.body);
        const booking = await booking_service_1.BookingService.updateBookingStatus(req.user, parseInt(req.params.id, 10), status);
        res.json(booking);
    }
    catch (error) {
        next(error);
    }
});
exports.default = router;
