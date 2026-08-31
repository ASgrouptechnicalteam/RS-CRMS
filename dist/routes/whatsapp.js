"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const messageTemplate_service_1 = require("../services/messageTemplate.service");
const router = (0, express_1.Router)();
// Resolve a template safely for Sales/Telecaller (doesn't require MESSAGE_TEMPLATES_MANAGE)
router.post('/resolve', auth_1.authenticateToken, // Just authentication, no specific global permission required for generating text links
async (req, res, next) => {
    try {
        const { template_key, phone, context } = req.body;
        if (!template_key || !phone) {
            return res.status(400).json({ error: 'template_key and phone are required' });
        }
        const ctx = context || {};
        // Resolve using the fallback mechanism so it always succeeds even if admin hasn't created it
        const resolved = await messageTemplate_service_1.MessageTemplateService.resolveWithFallback(template_key, ctx);
        // Clean phone number and ensure 91 prefix
        const cleanPhone = phone.replace(/[^0-9]/g, '');
        const formattedPhone = cleanPhone.startsWith('91') ? cleanPhone : '91' + cleanPhone;
        const whatsAppUrl = `https://wa.me/${formattedPhone}?text=${encodeURIComponent(resolved.body_text)}`;
        return res.json({
            whatsAppUrl,
            whatsAppText: resolved.body_text,
            templateKey: resolved.templateKey,
            usedFallback: resolved.usedFallback,
        });
    }
    catch (error) {
        next(error);
    }
});
exports.default = router;
