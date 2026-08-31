"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const auth_1 = require("../middleware/auth");
const authz_1 = require("../middleware/authz");
const shared_1 = require("../shared");
const payment_service_1 = require("../services/payment.service");
const router = (0, express_1.Router)();
// Zod schemas for validation
const RecordPaymentSchema = zod_1.z.object({
    booking_id: zod_1.z.number().int().positive(),
    installment_id: zod_1.z.number().int().positive().optional(),
    amount: zod_1.z.number().positive(),
    payment_method: zod_1.z.enum(['CASH', 'CHEQUE', 'BANK_TRANSFER', 'ONLINE']),
    reference_number: zod_1.z.string().optional().nullable(),
    notes: zod_1.z.string().optional(),
});
const VerifyPaymentSchema = zod_1.z.object({
    status: zod_1.z.enum(['SUCCESS', 'FAILED', 'REFUNDED']),
});
// Routes
router.use(auth_1.authenticateToken);
router.get('/', (0, authz_1.requireAuthz)(shared_1.Permissions.PAYMENTS_READ), async (req, res, next) => {
    try {
        const bookingId = req.query.booking_id ? parseInt(req.query.booking_id, 10) : undefined;
        const payments = await payment_service_1.PaymentService.getPayments(req.user, bookingId);
        res.json(payments);
    }
    catch (error) {
        next(error);
    }
});
router.post('/', (0, authz_1.requireAuthz)(shared_1.Permissions.PAYMENTS_CREATE), async (req, res, next) => {
    try {
        const dto = RecordPaymentSchema.parse(req.body);
        const payment = await payment_service_1.PaymentService.recordPayment(req.user, dto);
        res.status(201).json(payment);
    }
    catch (error) {
        next(error);
    }
});
router.put('/:id/status', (0, authz_1.requireAuthz)(shared_1.Permissions.PAYMENTS_UPDATE), async (req, res, next) => {
    try {
        const { status } = VerifyPaymentSchema.parse(req.body);
        const payment = await payment_service_1.PaymentService.verifyPayment(req.user, parseInt(req.params.id, 10), status);
        res.json(payment);
    }
    catch (error) {
        next(error);
    }
});
exports.default = router;
