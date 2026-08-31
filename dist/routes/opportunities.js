"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const shared_1 = require("../shared");
const opportunity_service_1 = require("../services/opportunity.service");
const router = (0, express_1.Router)();
// POST /api/v1/opportunities
router.post('/', auth_1.authenticateToken, (0, auth_1.requirePermission)([shared_1.Permissions.LEADS_UPDATE]), // Assuming lead management permissions govern opportunity creation
async (req, res, next) => {
    try {
        const opportunity = await opportunity_service_1.OpportunityService.createFromLead(req.user, req.body);
        return res.status(201).json({
            message: 'Opportunity created successfully',
            opportunity,
        });
    }
    catch (error) {
        console.error('Create opportunity error:', error);
        next(error);
    }
});
// GET /api/v1/opportunities
router.get('/', auth_1.authenticateToken, (0, auth_1.requirePermission)([shared_1.Permissions.LEADS_READ]), async (req, res, next) => {
    try {
        const { stage, owner_id, project_id, property_id, date_from, date_to, expected_close_from, expected_close_to, sort_by, sort_order, limit, offset } = req.query;
        const filters = {
            stage: stage,
            owner_id: owner_id,
            project_id: project_id,
            property_id: property_id,
            date_from: date_from,
            date_to: date_to,
            expected_close_from: expected_close_from,
            expected_close_to: expected_close_to,
            sort_by: sort_by,
            sort_order: sort_order,
            limit: limit,
            offset: offset,
        };
        const result = await opportunity_service_1.OpportunityService.getOpportunities(req.user, filters);
        return res.status(200).json(result);
    }
    catch (error) {
        console.error('Fetch opportunities error:', error);
        next(error);
    }
});
// GET /api/v1/opportunities/pipeline-metrics
router.get('/pipeline-metrics', auth_1.authenticateToken, (0, auth_1.requirePermission)([shared_1.Permissions.LEADS_READ]), async (req, res, next) => {
    try {
        const metrics = await opportunity_service_1.OpportunityService.getPipelineMetrics(req.user);
        return res.status(200).json({ metrics });
    }
    catch (error) {
        console.error('Fetch pipeline metrics error:', error);
        next(error);
    }
});
// GET /api/v1/opportunities/:id
router.get('/:id', auth_1.authenticateToken, (0, auth_1.requirePermission)([shared_1.Permissions.LEADS_READ]), async (req, res, next) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        if (isNaN(id))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        if (isNaN(id))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        if (isNaN(id))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        const opportunity = await opportunity_service_1.OpportunityService.getOpportunityById(req.user, id);
        return res.status(200).json({ opportunity });
    }
    catch (error) {
        console.error('Fetch opportunity dossier error:', error);
        next(error);
    }
});
// PATCH /api/v1/opportunities/:id
router.patch('/:id', auth_1.authenticateToken, (0, auth_1.requirePermission)([shared_1.Permissions.LEADS_UPDATE]), async (req, res, next) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        if (isNaN(id))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        if (isNaN(id))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        if (isNaN(id))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        const opportunity = await opportunity_service_1.OpportunityService.updateOpportunity(req.user, id, req.body);
        return res.status(200).json({
            message: 'Opportunity updated successfully',
            opportunity,
        });
    }
    catch (error) {
        console.error('Update opportunity error:', error);
        next(error);
    }
});
// POST /api/v1/opportunities/:id/convert-to-booking
router.post('/:id/convert-to-booking', auth_1.authenticateToken, (0, auth_1.requirePermission)([shared_1.Permissions.LEADS_UPDATE]), // Requires same update permission
async (req, res, next) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        if (isNaN(id))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        if (isNaN(id))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        if (isNaN(id))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        const booking = await opportunity_service_1.OpportunityService.convertToBooking(req.user, id, req.body);
        return res.status(201).json({
            message: 'Opportunity converted to Booking successfully',
            booking,
        });
    }
    catch (error) {
        console.error('Convert opportunity to booking error:', error);
        next(error);
    }
});
exports.default = router;
