"use strict";
/**
 * Phase 17-A — Deterministic mock provider.
 *
 * - Never contacts the network.
 * - Never reads provider credentials / API keys / .env secrets.
 * - Returns deterministic output and simulated usage.
 * - Supports controlled success/failure scenarios for tests.
 * - Replaceable by a real provider adapter in a later packet.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MockProvider = void 0;
const provider_1 = require("./provider");
class MockProvider {
    constructor(options = {}) {
        this.options = options;
        this.capabilities = {
            provider: 'mock',
            supportsStreaming: false,
            maxOutputTokens: 1024,
            supportsUsage: true,
        };
    }
    async generate(request) {
        const failure = this.options.failure;
        if (failure) {
            throw new provider_1.AIProviderError({
                category: failure,
                message: `Mock provider failure: ${failure}`,
                retryable: failure === 'PROVIDER_UNAVAILABLE' || failure === 'RATE_LIMITED' || failure === 'TIMEOUT',
                provider: 'mock',
            });
        }
        const usage = this.options.usage ?? {
            provider: 'mock',
            model: request.model ?? 'mock-model',
            inputTokens: 10,
            outputTokens: 20,
            totalTokens: 30,
            estimatedCost: 0.0001,
        };
        return {
            content: this.options.content ??
                `Deterministic mock response for ${request.metadata.companyId}`,
            model: request.model ?? 'mock-model',
            usage,
            metadata: request.metadata,
        };
    }
}
exports.MockProvider = MockProvider;
