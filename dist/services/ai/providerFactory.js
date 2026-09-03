"use strict";
/**
 * Phase 17-B — Provider selection factory.
 *
 * Resolves the configured `AI_PROVIDER` to an `AIProvider` instance. `mock` is the default
 * and requires no credentials (deterministic, offline). `openrouter` is recognized but its
 * live path is gated pending human approval (see openRouterProvider header). Unknown provider
 * names FAIL FAST so misconfiguration is loud, never silent.
 *
 * Provider credentials come ONLY from process.env — never committed, never returned by APIs.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAIProvider = void 0;
const config_1 = require("./config");
const mockProvider_1 = require("./mockProvider");
const openRouterProvider_1 = require("./openRouterProvider");
function requireOpenRouterKey() {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key || key.trim() === '') {
        throw new config_1.AIConfigError('OPENROUTER_API_KEY is required when AI_PROVIDER=openrouter.');
    }
    return key.trim();
}
function requireModel(config) {
    if (!config.model || config.model.trim() === '') {
        throw new config_1.AIConfigError('AI_MODEL is required when AI_PROVIDER=openrouter.');
    }
    return config.model.trim();
}
function createAIProvider(config) {
    const name = (config.provider || '').trim().toLowerCase();
    if (name === '' || name === 'mock') {
        return new mockProvider_1.MockProvider();
    }
    if (name === openRouterProvider_1.OPENROUTER_PROVIDER) {
        return new openRouterProvider_1.OpenRouterProvider({ apiKey: requireOpenRouterKey(), model: requireModel(config) });
    }
    throw new config_1.AIConfigError(`Unsupported AI_PROVIDER '${config.provider}'. Supported: mock, openrouter.`);
}
exports.createAIProvider = createAIProvider;
