"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const shared_1 = require("../shared");
const validate_1 = require("../middleware/validate");
const messageTemplate_service_1 = require("../services/messageTemplate.service");
const router = (0, express_1.Router)();
// List all templates (active + inactive) for the admin editor.
router.get('/', auth_1.authenticateToken, (0, auth_1.requirePermission)([shared_1.Permissions.MESSAGE_TEMPLATES_MANAGE]), async (req, res, next) => {
    try {
        const templates = await messageTemplate_service_1.MessageTemplateService.list();
        return res.json(templates);
    }
    catch (error) {
        next(error);
    }
});
// Resolve a single template to its substituted body_text (for a deep-link preview).
router.get('/:key/resolve', auth_1.authenticateToken, (0, auth_1.requirePermission)([shared_1.Permissions.MESSAGE_TEMPLATES_MANAGE]), async (req, res, next) => {
    try {
        const key = req.params.key;
        const ctx = {
            customer_name: req.query.customer_name,
            property_name: req.query.property_name,
            pm_name: req.query.pm_name,
            visit_date: req.query.visit_date,
        };
        const resolved = await messageTemplate_service_1.MessageTemplateService.resolve(key, ctx);
        if (!resolved) {
            return res.status(404).json({ error: 'No active template found for key' });
        }
        return res.json(resolved);
    }
    catch (error) {
        next(error);
    }
});
// Upsert a template by key (admin editor save).
router.post('/', auth_1.authenticateToken, (0, auth_1.requirePermission)([shared_1.Permissions.MESSAGE_TEMPLATES_MANAGE]), (0, validate_1.validateRequestBody)(shared_1.MessageTemplateSchema), async (req, res, next) => {
    try {
        const saved = await messageTemplate_service_1.MessageTemplateService.upsert(req.body);
        return res.status(201).json(saved);
    }
    catch (error) {
        next(error);
    }
});
// Activate / deactivate a template.
router.patch('/:key/active', auth_1.authenticateToken, (0, auth_1.requirePermission)([shared_1.Permissions.MESSAGE_TEMPLATES_MANAGE]), async (req, res, next) => {
    try {
        const isActive = req.body?.is_active === true || req.body?.is_active === 'true';
        const updated = await messageTemplate_service_1.MessageTemplateService.setActive(req.params.key, isActive);
        return res.json(updated);
    }
    catch (error) {
        next(error);
    }
});
exports.default = router;
