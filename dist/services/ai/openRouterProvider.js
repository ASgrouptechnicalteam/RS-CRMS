"use strict";
/**
 * Phase 17-B — OpenRouter provider adapter (boundary).
 *
 * This module is the ONLY place OpenRouter-specific request/response/error mapping lives.
 * The rest of the AI core depends only on the canonical AIProvider / AIRequest / AIResponse /
 * AIProviderError contracts. Provider detail is normalized here and never escapes.
 *
  * Runtime approach: `@openrouter/sdk@1.2.17` is declared in the root `package.json` but is NOT
 * imported here. This adapter issues a direct HTTPS request to the documented OpenRouter
 * chat-completions HTTP API using the runtime-global `fetch` (Node >= 18), keeping the
 * adapter dependency-free and the provider-agnostic core boundary clean. The SDK is
 * deliberately avoided to keep the integration narrow, transparent, and free of any
 * provider-specific types leaking into the core.
 *
 * The API key and model come ONLY from server-side configuration (process.env via the
 * factory), never from the client and never hardcoded. Secrets are never logged and never
 * returned in error messages — errors are normalized into the canonical AIProviderError
 * contract by `classifyOpenRouterError`.
 *
 * Timeout and bounded retry are owned by `AIGateway` (not duplicated here). Only retryable
 * categories are surfaced so the gateway can retry; a network-level failure is mapped to
 * PROVIDER_UNAVAILABLE so the gateway treats it consistently.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpenRouterProvider = exports.classifyOpenRouterError = exports.parseOpenRouterResponse = exports.buildOpenRouterBody = exports.OPENROUTER_CHAT_URL = exports.OPENROUTER_PROVIDER = void 0;
const provider_1 = require("./provider");
exports.OPENROUTER_PROVIDER = 'openrouter';
/**
 * OpenRouter chat-completions HTTP endpoint (documented public API).
 * Defaults to the live endpoint; `OpenRouterProviderOptions.baseUrl` may override
 * it (primarily for testing).
 */
exports.OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
/** App-level identity sent in OpenRouter's required headers (not a secret). */
const OPENROUTER_DEFAULT_REFERER = 'https://crm.rradharealhomes.com';
const OPENROUTER_APP_TITLE = 'RRH-CRMS AI Search';
/** Build the provider-specific chat-completion request from a canonical AIRequest (pure). */
function buildOpenRouterBody(request, model) {
    return {
        model,
        messages: request.messages,
        temperature: request.temperature ?? 0,
        max_tokens: request.maxTokens,
        // Strongest structured-output hint where supported. Provider-led JSON extraction.
        response_format: { type: 'json_object' },
    };
}
exports.buildOpenRouterBody = buildOpenRouterBody;
/** Normalize a raw provider chat-completion response into a canonical AIResponse (pure). */
function parseOpenRouterResponse(body, request, provider) {
    const b = body;
    const choice = (b && b.choices && b.choices[0]) || {};
    const message = choice.message || {};
    const content = typeof message.content === 'string'
        ? message.content
        : typeof choice.text === 'string'
            ? choice.text
            : '';
    if (!content) {
        throw new provider_1.AIProviderError({
            category: 'INVALID_PROVIDER_RESPONSE',
            message: 'OpenRouter returned an empty response.',
            retryable: false,
            provider,
        });
    }
    const usageRaw = b && b.usage;
    const usage = usageRaw && typeof usageRaw === 'object'
        ? {
            provider,
            model: String(b.model || request.model || provider),
            inputTokens: Number(usageRaw.prompt_tokens ?? 0),
            outputTokens: Number(usageRaw.completion_tokens ?? 0),
            totalTokens: Number(usageRaw.total_tokens ?? 0),
        }
        : null;
    return {
        content,
        model: String(b.model || request.model || provider),
        usage,
        metadata: request.metadata,
    };
}
exports.parseOpenRouterResponse = parseOpenRouterResponse;
function looksLikeQuota(err) {
    const msg = String(err?.message || '');
    return /insufficient.quota|quota|out.?of.?credit|402/i.test(msg);
}
/** Normalize a provider failure into the canonical error model (pure). */
function classifyOpenRouterError(err, provider) {
    const status = Number(err?.status ?? err?.statusCode ?? err?.response?.status ?? 0);
    if (status === 429) {
        return { category: 'RATE_LIMITED', message: 'OpenRouter rate limited', retryable: true, provider };
    }
    if (status === 402 || looksLikeQuota(err)) {
        return { category: 'QUOTA_EXCEEDED', message: 'OpenRouter quota exceeded', retryable: false, provider };
    }
    if (status === 401 || status === 403) {
        return { category: 'CONFIGURATION_ERROR', message: 'OpenRouter authentication/authorization failed', retryable: false, provider };
    }
    if (status === 408) {
        return { category: 'TIMEOUT', message: 'OpenRouter timed out', retryable: true, provider };
    }
    if (status >= 500 || status === 502 || status === 503 || status === 504) {
        return { category: 'PROVIDER_UNAVAILABLE', message: 'OpenRouter unavailable', retryable: true, provider };
    }
    return { category: 'UNKNOWN_PROVIDER_ERROR', message: 'OpenRouter error', retryable: false, provider };
}
exports.classifyOpenRouterError = classifyOpenRouterError;
/**
 * OpenRouter provider adapter. Issues a direct HTTPS chat-completions request via the
 * runtime-global `fetch` to the documented OpenRouter HTTP API. The provider abstraction,
 * timeout, retry, and error normalization remain owned by the core/AIProvider contract and
 * AIGateway.
 */
class OpenRouterProvider {
    options;
    capabilities = {
        provider: exports.OPENROUTER_PROVIDER,
        supportsStreaming: false,
        maxOutputTokens: 8192,
        supportsUsage: true,
    };
    constructor(options) {
        this.options = options;
    }
    async generate(request) {
        const url = this.options.baseUrl ?? exports.OPENROUTER_CHAT_URL;
        const body = buildOpenRouterBody(request, this.options.model);
        // AbortController-based timeout — prevents dangling fetch promises if OpenRouter
        // hangs indefinitely. Also enforced by AIGateway.withTimeout (30s default).
        const abortController = new AbortController();
        const timeoutMs = 30_000; // matches AIConfig.default timeoutMs
        const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${this.options.apiKey}`,
                    'Content-Type': 'application/json',
                    'HTTP-Referer': OPENROUTER_DEFAULT_REFERER,
                    'X-Title': OPENROUTER_APP_TITLE,
                },
                body: JSON.stringify(body),
                signal: abortController.signal,
            }).catch((err) => {
                // Normalize immediately — the raw network error must never escape the provider
                // boundary. Distinguish abort (timeout) from other network failures.
                const info = err.name === 'AbortError'
                    ? {
                        category: 'TIMEOUT',
                        message: 'OpenRouter request timed out.',
                        retryable: true,
                        provider: exports.OPENROUTER_PROVIDER,
                    }
                    : {
                        category: 'PROVIDER_UNAVAILABLE',
                        message: 'OpenRouter request could not be completed (network error).',
                        retryable: true,
                        provider: exports.OPENROUTER_PROVIDER,
                    };
                throw new provider_1.AIProviderError(info);
            });
            if (!response.ok) {
                let errBody = {};
                try {
                    errBody = (await response.json());
                }
                catch {
                    /* non-JSON error body — fall back to status text */
                }
                throw new provider_1.AIProviderError(classifyOpenRouterError({ status: response.status, message: errBody?.error?.message ?? response.statusText }, exports.OPENROUTER_PROVIDER));
            }
            const data = await response.json();
            return parseOpenRouterResponse(data, request, exports.OPENROUTER_PROVIDER);
        }
        finally {
            // Always clear the timeout so the abort timer never leaks as an open handle.
            clearTimeout(timeoutId);
        }
    }
}
exports.OpenRouterProvider = OpenRouterProvider;
