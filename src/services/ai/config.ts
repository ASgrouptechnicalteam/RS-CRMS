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

import { z } from 'zod';

export interface AIConfigInput {
  enabled?: boolean;
  provider?: string;
  model?: string;
  timeoutMs?: number;
  maxTokens?: number;
  maxRetries?: number;
}

export class AIConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AIConfigError';
  }
}

/**
 * Validated, immutable AI configuration snapshot.
 * Construct via AIConfig.fromEnv() or AIConfig.from(deps, input).
 */
export class AIConfig {
  readonly enabled: boolean;
  readonly provider: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly maxTokens: number;
  readonly maxRetries: number;

  /**
   * Zod schema enforcing the numeric configuration invariants (finite positive timeout,
   * finite positive token cap, bounded 0..5 retry count). AIConfigError, not ZodError, is
   * thrown to keep a stable provider-independent error contract.
   */
  private static readonly ConfigSchema = z
    .object({
      timeoutMs: z.number().finite().positive(),
      maxTokens: z.number().finite().positive(),
      maxRetries: z.number().int().min(0).max(5),
    });

  private constructor(input: AIConfigInput) {
    this.enabled = input.enabled ?? false;
    this.provider = input.provider ?? 'mock';
    this.model = input.model ?? '';
    this.timeoutMs = input.timeoutMs ?? 30_000;
    this.maxTokens = input.maxTokens ?? 1024;
    this.maxRetries = input.maxRetries ?? 1;
  }

  /** Build config from explicit (testable) values. */
  static from(input: AIConfigInput): AIConfig {
    return AIConfig.validate(new AIConfig(input));
  }

  /** Build config from process.env, following the repository's env convention. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): AIConfig {
    const input: AIConfigInput = {
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
  private static validate(cfg: AIConfig): AIConfig {
    const numeric = AIConfig.ConfigSchema.safeParse({
      timeoutMs: cfg.timeoutMs,
      maxTokens: cfg.maxTokens,
      maxRetries: cfg.maxRetries,
    });
    if (!numeric.success) {
      throw new AIConfigError(
        'Invalid AI configuration: ' +
          numeric.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
      );
    }
    if (cfg.enabled && cfg.provider.trim() === '') {
      throw new AIConfigError('Enabled AI is missing a provider.');
    }
    return cfg;
  }
}