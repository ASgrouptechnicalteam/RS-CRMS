"use strict";
/**
 * Phase 17-A — Configuration abstraction.
 *
 * Follows the repository's `process.env` + `dotenv` convention. No hardcoded
 * credentials, no secret values, no provider API keys. Fail-fast when AI is
 * explicitly enabled but required configuration is absent; safe (disabled) when
 * AI is not enabled. Tests run with AI disabled or a mock provider.
 *
 * Env contract (only the fields the foundation actually consumes):
 *   AI_ENABLED          - 'true' enables AI; anything else treats AI as disabled
 *   AI_PROVIDER         - internal provider selection (e.g. 'mock'); NOT client-controlled
 *   AI_MODEL            - optional default model
 *   AI_TIMEOUT_MS       - positive request timeout
 *   AI_MAX_TOKENS       - positive output token cap
 *   AI_MAX_RETRIES      - non-negative bounded retry count
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.AIConfig = exports.AIConfigError = void 0;
const zod_1 = require("zod");
class AIConfigError extends Error {
    constructor(message) {
        super(message);
        this.name = 'AIConfigError';
    }
}
exports.AIConfigError = AIConfigError;
/**
 * Validated, immutable AI configuration snapshot.
 * Construct via AIConfig.fromEnv() or AIConfig.from(deps, input).
 */
class AIConfig {
    enabled;
    provider;
    model;
    timeoutMs;
    maxTokens;
    maxRetries;
    /**
     * Zod schema enforcing the numeric configuration invariants (finite positive timeout,
     * finite positive token cap, bounded 0..5 retry count). AIConfigError, not ZodError, is
     * thrown to keep a stable provider-independent error contract.
     */
    static ConfigSchema = zod_1.z
        .object({
        timeoutMs: zod_1.z.number().finite().positive(),
        maxTokens: zod_1.z.number().finite().positive(),
        maxRetries: zod_1.z.number().int().min(0).max(5),
    });
    constructor(input) {
        this.enabled = input.enabled ?? false;
        this.provider = input.provider ?? 'mock';
        this.model = input.model ?? '';
        this.timeoutMs = input.timeoutMs ?? 30_000;
        this.maxTokens = input.maxTokens ?? 1024;
        this.maxRetries = input.maxRetries ?? 1;
    }
    /** Build config from explicit (testable) values. */
    static from(input) {
        return AIConfig.validate(new AIConfig(input));
    }
    /** Build config from process.env, following the repository's env convention. */
    static fromEnv(env = process.env) {
        const input = {
            enabled: env.AI_ENABLED === 'true',
            provider: env.AI_PROVIDER || undefined,
            model: env.AI_MODEL || undefined,
            timeoutMs: env.AI_TIMEOUT_MS ? Number(env.AI_TIMEOUT_MS) : undefined,
            maxTokens: env.AI_MAX_TOKENS ? Number(env.AI_MAX_TOKENS) : undefined,
            maxRetries: env.AI_MAX_RETRIES ? Number(env.AI_MAX_RETRIES) : undefined,
        };
        // When AI is enabled but no provider is configured, fail fast.
        if (input.enabled && (!input.provider || input.provider.trim() === '')) {
            throw new AIConfigError('AI_ENABLED is true but AI_PROVIDER is not configured.');
        }
        return AIConfig.validate(new AIConfig(input));
    }
    /** Reject invalid numeric / logical values; ensure bounded, non-infinite retries. */
    static validate(cfg) {
        const numeric = AIConfig.ConfigSchema.safeParse({
            timeoutMs: cfg.timeoutMs,
            maxTokens: cfg.maxTokens,
            maxRetries: cfg.maxRetries,
        });
        if (!numeric.success) {
            throw new AIConfigError('Invalid AI configuration: ' +
                numeric.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
        }
        if (cfg.enabled && cfg.provider.trim() === '') {
            throw new AIConfigError('Enabled AI is missing a provider.');
        }
        return cfg;
    }
}
exports.AIConfig = AIConfig;
