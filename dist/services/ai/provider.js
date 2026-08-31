"use strict";
/**
 * Phase 17-A — Provider boundary.
 *
 * `AIProvider` is the provider-independent interface. No OpenAI/OpenRouter/etc.
 * types appear here. Real providers (OpenAI, OpenRouter, Ollama, ...) are later
 * packets; 17-A ships only the interface + a deterministic mock.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.AIProviderError = void 0;
/** Provider-facing failure signal. Providers throw this (or the gateway normalizes). */
class AIProviderError extends Error {
    info;
    constructor(info) {
        super(info.message);
        this.name = 'AIProviderError';
        this.info = info;
    }
}
exports.AIProviderError = AIProviderError;
