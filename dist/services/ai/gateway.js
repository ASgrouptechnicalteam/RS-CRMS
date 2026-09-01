"use strict";
/**
 * Phase 17-A — AI gateway: timeout + bounded retry + normalized error surface.
 *
 * The core application layer depends only on this gateway, never on provider SDKs.
 * Retries apply ONLY to retryable provider failures and respect the configured maximum;
 * invalid requests and unknown errors fail closed (no infinite retry loops).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.AIGateway = void 0;
const provider_1 = require("./provider");
const cost_1 = require("./cost");
const audit_1 = require("./audit");
function withTimeout(promise, timeoutMs) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (!settled) {
                settled = true;
                reject(new provider_1.AIProviderError({
                    category: 'TIMEOUT',
                    message: `Provider did not respond within ${timeoutMs}ms`,
                    retryable: true,
                }));
            }
        }, timeoutMs);
        promise.then((value) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
        }, (err) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            reject(err);
        });
    });
}
/** Normalize any thrown value into a provider-independent AIProviderErrorInfo. */
function normalizeError(err, provider) {
    if (err instanceof provider_1.AIProviderError)
        return err.info;
    const candidate = err?.info;
    if (candidate &&
        typeof candidate === 'object' &&
        'category' in candidate) {
        return candidate;
    }
    return {
        category: 'UNKNOWN_PROVIDER_ERROR',
        message: err instanceof Error ? err.message : 'Unknown provider error',
        retryable: false,
        provider,
    };
}
class AIGateway {
    constructor(deps) {
        this.deps = deps;
        this.costHook = deps.costHook ?? new cost_1.NullCostHook();
        this.auditHook = deps.auditHook ?? new audit_1.NullAuditHook();
    }
    async generate(request) {
        const provider = this.deps.provider;
        const maxAttempts = this.deps.config.maxRetries + 1;
        const startedAt = Date.now();
        let last = null;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            try {
                const response = await withTimeout(this.deps.provider.generate(request), this.deps.config.timeoutMs);
                const latencyMs = Date.now() - startedAt;
                this.auditHook.record(this.auditRecord(request, 'SUCCESS', latencyMs, response.usage));
                this.costHook.record(response.usage);
                return response;
            }
            catch (err) {
                const info = normalizeError(err, provider.capabilities.provider);
                last = info;
                this.auditHook.record(this.auditRecord(request, 'FAILURE', Date.now() - startedAt, undefined, info.category));
                const exhausted = attempt >= maxAttempts - 1;
                if (!info.retryable || exhausted) {
                    throw new provider_1.AIProviderError(info);
                }
            }
        }
        throw new provider_1.AIProviderError(last ?? { category: 'UNKNOWN_PROVIDER_ERROR', message: 'No provider attempt occurred', retryable: false });
    }
    auditRecord(request, status, latencyMs, usage, errorCategory) {
        return {
            requestId: request.metadata.requestId,
            correlationId: request.metadata.correlationId,
            companyId: request.metadata.companyId,
            employeeId: request.metadata.employeeId,
            provider: this.deps.provider.capabilities.provider,
            model: request.model || this.deps.provider.capabilities.provider,
            status,
            latencyMs,
            usage,
            promptVersion: request.metadata.promptVersion,
            responseVersion: request.metadata.responseVersion,
            errorCategory,
        };
    }
}
exports.AIGateway = AIGateway;
