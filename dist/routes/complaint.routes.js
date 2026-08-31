"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// Complaint Management API Routes (Phase 14 - Packet 14-1)
// Backend-only, authorized endpoints below. Middleware order: authenticate -> authorize -> validate -> handler.
const express_1 = require("express");
const zod_1 = require("zod");
const auth_1 = require("../middleware/auth");
const authz_1 = require("../middleware/authz");
const shared_1 = require("../shared");
const complaint_service_1 = require("../services/complaint.service");
const router = (0, express_1.Router)();
const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH'];
const STATUSES = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED', 'REOPENED'];
const CLOSURE_REASONS = ['RESOLVED', 'CUSTOMER_UNSATISFIED', 'NOT_APPLICABLE', 'CUSTOMER_WITHDRAWN'];
const CreateComplaintSchema = zod_1.z.object({
    customer_id: zod_1.z.number().int().positive(),
    title: zod_1.z.string().min(1, 'title is required'),
    category: zod_1.z.string().optional().nullable(),
    description: zod_1.z.string().optional().nullable(),
    priority: zod_1.z.enum(PRIORITIES).optional().nullable(),
    booking_id: zod_1.z.number().int().positive().optional().nullable(),
    property_id: zod_1.z.number().int().positive().optional().nullable(),
    assigned_employee_id: zod_1.z.number().int().positive().optional().nullable(),
});
const UpdateComplaintSchema = zod_1.z.object({
    title: zod_1.z.string().min(1).optional(),
    description: zod_1.z.string().optional().nullable(),
    category: zod_1.z.string().optional().nullable(),
    priority: zod_1.z.enum(PRIORITIES).optional().nullable(),
});
const AssignComplaintSchema = zod_1.z.object({ employee_id: zod_1.z.number().int().positive() });
const StatusSchema = zod_1.z.object({ status: zod_1.z.enum(STATUSES) });
const ResolveSchema = zod_1.z.object({ resolution_description: zod_1.z.string().min(1, 'resolution_description is required') });
const CloseSchema = zod_1.z.object({ closure_reason: zod_1.z.enum(CLOSURE_REASONS).optional() });
router.use(auth_1.authenticateToken);
// GET /api/v1/complaints
router.get('/', (0, authz_1.requireAuthz)(shared_1.Permissions.COMPLAINTS_READ), async (req, res, next) => {
    try {
        const complaints = await complaint_service_1.ComplaintService.list(req.user, {
            status: req.query.status,
            priority: req.query.priority,
            category: req.query.category,
            customer_id: req.query.customer_id ? parseInt(req.query.customer_id, 10) : undefined,
        });
        res.json(complaints);
    }
    catch (error) {
        next(error);
    }
});
// GET /api/v1/complaints/:id
router.get('/:id', (0, authz_1.requireAuthz)(shared_1.Permissions.COMPLAINTS_READ), async (req, res, next) => {
    try {
        const complaint = await complaint_service_1.ComplaintService.getById(req.user, parseInt(req.params.id, 10));
        res.json(complaint);
    }
    catch (error) {
        next(error);
    }
});
// POST /api/v1/complaints
router.post('/', (0, authz_1.requireAuthz)(shared_1.Permissions.COMPLAINTS_CREATE), async (req, res, next) => {
    try {
        const dto = CreateComplaintSchema.parse(req.body);
        const complaint = await complaint_service_1.ComplaintService.create(req.user, dto);
        res.status(201).json(complaint);
    }
    catch (error) {
        next(error);
    }
});
// PATCH /api/v1/complaints/:id
router.patch('/:id', (0, authz_1.requireAuthz)(shared_1.Permissions.COMPLAINTS_UPDATE), async (req, res, next) => {
    try {
        const dto = UpdateComplaintSchema.parse(req.body);
        const complaint = await complaint_service_1.ComplaintService.update(req.user, parseInt(req.params.id, 10), dto);
        res.json(complaint);
    }
    catch (error) {
        next(error);
    }
});
// PATCH /api/v1/complaints/:id/status
router.patch('/:id/status', (0, authz_1.requireAuthz)(shared_1.Permissions.COMPLAINTS_UPDATE), async (req, res, next) => {
    try {
        const { status } = StatusSchema.parse(req.body);
        const complaint = await complaint_service_1.ComplaintService.changeStatus(req.user, parseInt(req.params.id, 10), status);
        res.json(complaint);
    }
    catch (error) {
        next(error);
    }
});
// PATCH /api/v1/complaints/:id/assign
router.patch('/:id/assign', (0, authz_1.requireAuthz)(shared_1.Permissions.COMPLAINTS_ASSIGN), async (req, res, next) => {
    try {
        const { employee_id } = AssignComplaintSchema.parse(req.body);
        const complaint = await complaint_service_1.ComplaintService.assign(req.user, parseInt(req.params.id, 10), employee_id);
        res.json(complaint);
    }
    catch (error) {
        next(error);
    }
});
// PATCH /api/v1/complaints/:id/resolve
router.patch('/:id/resolve', (0, authz_1.requireAuthz)(shared_1.Permissions.COMPLAINTS_RESOLVE), async (req, res, next) => {
    try {
        const { resolution_description } = ResolveSchema.parse(req.body);
        const complaint = await complaint_service_1.ComplaintService.resolve(req.user, parseInt(req.params.id, 10), resolution_description);
        res.json(complaint);
    }
    catch (error) {
        next(error);
    }
});
// PATCH /api/v1/complaints/:id/close
router.patch('/:id/close', (0, authz_1.requireAuthz)(shared_1.Permissions.COMPLAINTS_CLOSE), async (req, res, next) => {
    try {
        const parsed = CloseSchema.parse(req.body);
        const complaint = await complaint_service_1.ComplaintService.close(req.user, parseInt(req.params.id, 10), parsed.closure_reason);
        res.json(complaint);
    }
    catch (error) {
        next(error);
    }
});
exports.default = router;
