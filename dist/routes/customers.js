"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const authz_1 = require("../middleware/authz");
const shared_1 = require("../shared");
const validate_1 = require("../middleware/validate");
const customer_service_1 = require("../services/customer.service");
const kyc_service_1 = require("../services/kyc.service");
const prisma_1 = require("../lib/prisma");
const router = (0, express_1.Router)();
const handleServiceError = (error, res) => {
    if (error instanceof customer_service_1.AppError) {
        return res.status(error.statusCode || 400).json({ error: error.message });
    }
    console.error('Unhandled route error:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
};
// GET /api/v1/customers - Fetch customers list
router.get('/', auth_1.authenticateToken, (0, authz_1.requireAuthz)(shared_1.Permissions.CUSTOMERS_READ), async (req, res) => {
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 100);
        const offset = Math.max(parseInt(req.query.offset) || 0, 0);
        const customers = await customer_service_1.CustomerService.getCustomers(req.user, limit, offset);
        return res.status(200).json({ customers, pagination: { limit, offset } });
    }
    catch (error) {
        return handleServiceError(error, res);
    }
});
// GET /api/v1/customers/:id - Fetch customer details
router.get('/:id', auth_1.authenticateToken, (0, authz_1.requireAuthz)(shared_1.Permissions.CUSTOMERS_READ), async (req, res) => {
    try {
        const customer = await customer_service_1.CustomerService.getCustomerById(req.user, parseInt(req.params.id));
        return res.status(200).json({ customer });
    }
    catch (error) {
        return handleServiceError(error, res);
    }
});
// POST /api/v1/customers - Create new customer
router.post('/', auth_1.authenticateToken, (0, authz_1.requireAuthz)(shared_1.Permissions.CUSTOMERS_CREATE), (0, validate_1.validateRequestBody)(shared_1.CustomerCreateSchema), async (req, res) => {
    try {
        const result = await customer_service_1.CustomerService.createCustomer(req.user, req.body);
        return res.status(201).json({
            message: 'Customer created successfully',
            ...result,
        });
    }
    catch (error) {
        return handleServiceError(error, res);
    }
});
// PATCH /api/v1/customers/:id - Update existing customer
router.patch('/:id', auth_1.authenticateToken, (0, authz_1.requireAuthz)(shared_1.Permissions.CUSTOMERS_UPDATE), (0, validate_1.validateRequestBody)(shared_1.CustomerUpdateSchema), async (req, res) => {
    try {
        const result = await customer_service_1.CustomerService.updateCustomer(req.user, parseInt(req.params.id), req.body);
        return res.status(200).json({
            message: 'Customer updated successfully',
            ...result,
        });
    }
    catch (error) {
        return handleServiceError(error, res);
    }
});
// PUT /api/v1/customers/:id/kyc - Write/update customer KYC (Phase 11 Packet 3C)
// CRM-internal write path. PAN/Aadhaar are encrypted at rest and NEVER leave CRMS.
router.put('/:id/kyc', auth_1.authenticateToken, (0, authz_1.requireAuthz)(shared_1.Permissions.CUSTOMERS_KYC_WRITE, async (req) => {
    return await prisma_1.prisma.customer.findFirst({ where: { id: parseInt(req.params.id, 10), company_id: req.user.companyId } });
}), (0, validate_1.validateRequestBody)(shared_1.CustomerKycWriteSchema), async (req, res) => {
    try {
        const result = await kyc_service_1.KycService.writeCustomerKyc(req.user, parseInt(req.params.id), req.body);
        return res.status(200).json({
            message: 'Customer KYC updated successfully',
            customer: result,
        });
    }
    catch (error) {
        return handleServiceError(error, res);
    }
});
exports.default = router;
