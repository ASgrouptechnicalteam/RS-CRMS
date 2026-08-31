"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const auth_1 = require("../middleware/auth");
const authz_1 = require("../middleware/authz");
const shared_1 = require("../shared");
const installment_service_1 = require("../services/installment.service");
const router = (0, express_1.Router)();
const CreateInstallmentSchema = zod_1.z.object({
    booking_id: zod_1.z.number().int().positive(),
    installment_number: zod_1.z.number().int().positive(),
    expected_amount: zod_1.z.number().positive(),
    due_date: zod_1.z.string().datetime(),
    remarks: zod_1.z.string().optional(),
});
router.use(auth_1.authenticateToken);
router.get('/', (0, authz_1.requireAuthz)(shared_1.Permissions.BOOKINGS_READ), async (req, res, next) => {
    try {
        const bookingId = req.query.booking_id ? parseInt(req.query.booking_id, 10) : undefined;
        if (!bookingId) {
            return res.status(400).json({ error: 'booking_id query parameter is required' });
        }
        const installments = await installment_service_1.InstallmentService.getInstallments(req.user, bookingId);
        res.json(installments);
    }
    catch (error) {
        next(error);
    }
});
router.post('/', (0, authz_1.requireAuthz)(shared_1.Permissions.PAYMENTS_CREATE), // Only those who can create payments can create a schedule
async (req, res, next) => {
    try {
        const dto = CreateInstallmentSchema.parse(req.body);
        const installment = await installment_service_1.InstallmentService.createInstallment(req.user, dto.booking_id, dto);
        res.status(201).json(installment);
    }
    catch (error) {
        next(error);
    }
});
exports.default = router;
