"use strict";
/**
 * Phase 17-B/17-D — AI Search + AI Chat API routes.
 *
 * Search flow: authenticateToken → aiSearchLimiter → requireAuthz(AI_SEARCH) →
 *   validateRequestBody(AISearchRequestSchema) → SearchIntentService.extract
 *   (server-derived req.user.companyId) → COMPLETE/INCOMPLETE.
 *
 * Chat flow (Phase 17-D): authenticateToken → aiSearchLimiter →
 *   requireAuthz(AI_SEARCH) → validateRequestBody(AIChatRequestSchema) →
 *   SearchIntentService.chat → CLARIFICATION or COMPLETE SearchIntent.
 *
 * The AI's responsibility ends at SearchIntent — CRM performs deterministic
 * filtering, matching, scoring and ranking (Phase 17-C). The client can never
 * control tenant identity, provider, model, credentials, permissions, or tools.
 * Chat history is ephemeral (client-managed); nothing is persisted server-side.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAISearchRouter = void 0;
const express_1 = require("express");
const shared_1 = require("../shared");
const auth_1 = require("../middleware/auth");
const authz_1 = require("../middleware/authz");
const validate_1 = require("../middleware/validate");
const rateLimiter_1 = require("../middleware/rateLimiter");
const searchApi_1 = require("../services/ai/searchApi");
const config_1 = require("../services/ai/config");
const providerFactory_1 = require("../services/ai/providerFactory");
const provider_1 = require("../services/ai/provider");
const searchIntent_1 = require("../services/ai/searchIntent");
const searchIntentBridge_1 = require("../services/ai/searchIntentBridge");
const application_1 = require("../services/ai/application");
const chatApi_1 = require("../services/ai/chatApi");
function mapAIError(err, res) {
    if (err instanceof provider_1.AIProviderError) {
        const table = {
            TIMEOUT: { status: 504, code: 'TIMEOUT' },
            RATE_LIMITED: { status: 429, code: 'RATE_LIMITED' },
            QUOTA_EXCEEDED: { status: 429, code: 'QUOTA_EXCEEDED' },
            PROVIDER_UNAVAILABLE: { status: 502, code: 'PROVIDER_UNAVAILABLE' },
            INVALID_PROVIDER_RESPONSE: { status: 502, code: 'INVALID_PROVIDER_RESPONSE' },
            MODEL_UNAVAILABLE: { status: 502, code: 'MODEL_UNAVAILABLE' },
            INVALID_REQUEST: { status: 400, code: 'INVALID_REQUEST' },
            CONFIGURATION_ERROR: { status: 500, code: 'CONFIGURATION_ERROR' },
            UNKNOWN_PROVIDER_ERROR: { status: 502, code: 'UPSTREAM_ERROR' },
        };
        const mapped = table[err.info.category] ?? { status: 502, code: 'UPSTREAM_ERROR' };
        res.status(mapped.status).json({
            error: mapped.status >= 500 ? 'AI service temporarily unavailable' : 'AI request could not be completed',
            code: mapped.code,
        });
        return;
    }
    if (err instanceof application_1.InvalidAIStructuredOutputError || err instanceof searchIntent_1.InvalidSearchIntentError) {
        res.status(422).json({ error: 'AI returned invalid structured output', code: 'INVALID_AI_OUTPUT' });
        return;
    }
    if (err instanceof application_1.AITenantOverrideError || err instanceof application_1.InvalidAIInputError || err instanceof application_1.InvalidChatInputError) {
        res.status(400).json({ error: 'Invalid AI request', code: 'INVALID_REQUEST' });
        return;
    }
    if (err instanceof config_1.AIConfigError) {
        res.status(500).json({ error: 'AI is not configured correctly', code: 'CONFIGURATION_ERROR' });
        return;
    }
    if (err instanceof searchIntentBridge_1.CRMSearchError) {
        res.status(502).json({ error: 'CRM property search failed', code: 'CRM_SEARCH_ERROR' });
        return;
    }
    if (err && err.statusCode) {
        const status = err.statusCode;
        if (status >= 500) {
            console.error('[ai-search]', err);
            res.status(status).json({ error: 'Internal Server Error', code: 'INTERNAL_ERROR' });
            return;
        }
        res.status(status).json({ error: 'Invalid request', code: 'INVALID_REQUEST' });
        return;
    }
    console.error('[ai-search]', err);
    res.status(500).json({ error: 'Internal Server Error', code: 'INTERNAL_ERROR' });
}
function defaultService() {
    const config = config_1.AIConfig.fromEnv();
    return new application_1.SearchIntentService({ provider: (0, providerFactory_1.createAIProvider)(config), config });
}
function createAISearchRouter(service) {
    const router = (0, express_1.Router)();
    const svc = service ?? defaultService();
    router.post('/search', auth_1.authenticateToken, rateLimiter_1.aiSearchLimiter, (0, authz_1.requireAuthz)(shared_1.Permissions.AI_SEARCH), (0, validate_1.validateRequestBody)(searchApi_1.AISearchRequestSchema), async (req, res) => {
        try {
            const caller = {
                companyId: req.user.companyId,
                employeeId: req.user.employeeId,
            };
            const extraction = await svc.extract(req.body, caller);
            const response = (0, searchApi_1.buildSearchApiResponse)(extraction);
            // Phase 17-C: the deterministic CRM bridge decides what matches (never the AI).
            // companyId is the authenticated caller's — client can never control it.
            if (extraction.status === 'COMPLETE' && extraction.searchIntent) {
                try {
                    response.results = await (0, searchIntentBridge_1.searchCrmMatches)(extraction.searchIntent, caller.companyId);
                }
                catch (crmErr) {
                    mapAIError(new searchIntentBridge_1.CRMSearchError('CRM property search failed'), res);
                    return;
                }
            }
            res.status(200).json(response);
        }
        catch (err) {
            mapAIError(err, res);
        }
    });
    // Phase 17-D — POST /api/v1/ai/chat
    // Flow: authenticateToken → aiSearchLimiter → requireAuthz(AI_SEARCH) →
    //   validateRequestBody(AIChatRequestSchema) → SearchIntentService.chat
    //   (server-derived req.user.companyId) → CLARIFICATION or COMPLETE SearchIntent.
    // On COMPLETE, the deterministic 17-C CRM bridge runs and returns results.
    // The conversation is ephemeral (client-managed) — nothing is persisted here.
    router.post('/chat', auth_1.authenticateToken, rateLimiter_1.aiSearchLimiter, (0, authz_1.requireAuthz)(shared_1.Permissions.AI_SEARCH), (0, validate_1.validateRequestBody)(chatApi_1.AIChatRequestSchema), async (req, res) => {
        try {
            const caller = {
                companyId: req.user.companyId,
                employeeId: req.user.employeeId,
            };
            const chatResult = await svc.chat(req.body, caller);
            const response = (0, chatApi_1.buildChatApiResponse)(chatResult);
            // Phase 17-C: when the chat resolves to COMPLETE, the deterministic CRM
            // bridge decides matches (never the AI). companyId stays server-derived.
            if (chatResult.status === 'COMPLETE' && chatResult.searchIntent) {
                try {
                    response.results = await (0, searchIntentBridge_1.searchCrmMatches)(chatResult.searchIntent, caller.companyId);
                }
                catch (crmErr) {
                    mapAIError(new searchIntentBridge_1.CRMSearchError('CRM property search failed'), res);
                    return;
                }
            }
            res.status(200).json(response);
        }
        catch (err) {
            mapAIError(err, res);
        }
    });
    return router;
}
exports.createAISearchRouter = createAISearchRouter;
exports.default = createAISearchRouter();
