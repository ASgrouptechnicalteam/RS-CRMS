/**
 * Phase 17-A — Deterministic mock provider.
 *
 * - Never contacts the network.
 * - Never reads provider credentials / API keys / .env secrets.
 * - Returns deterministic output and simulated usage.
 * - Supports controlled success/failure scenarios for tests.
 * - Replaceable by a real provider adapter in a later packet.
 */

import { AIRequest, AIResponse, AIUsage } from './types';
import { AIProvider, AIProviderError } from './provider';

/** Failure scenarios the mock can be programmed to produce for tests. */
export type MockFailure =
  | 'PROVIDER_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'INVALID_PROVIDER_RESPONSE'
  | 'QUOTA_EXCEEDED';

export interface MockProviderOptions {
  /** Deterministic output content returned on success. */
  content?: string;
  /** Optional programmatic failure. */
  failure?: MockFailure;
  /** Simulated usage metadata. */
  usage?: AIUsage;
}

export class MockProvider implements AIProvider {
  readonly capabilities = {
    provider: 'mock',
    supportsStreaming: false,
    maxOutputTokens: 1024,
    supportsUsage: true,
  } as const;

  constructor(private readonly options: MockProviderOptions = {}) {}

  async generate(request: AIRequest): Promise<AIResponse> {
    const failure = this.options.failure;
    if (failure) {
      throw new AIProviderError({
        category: failure,
        message: `Mock provider failure: ${failure}`,
        retryable: failure === 'PROVIDER_UNAVAILABLE' || failure === 'RATE_LIMITED' || failure === 'TIMEOUT',
        provider: 'mock',
      });
    }

    const usage: AIUsage = this.options.usage ?? {
      provider: 'mock',
      model: request.model ?? 'mock-model',
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      estimatedCost: 0.0001,
    };

    return {
      content:
        this.options.content ??
        `Deterministic mock response for ${request.metadata.companyId}`,
      model: request.model ?? 'mock-model',
      usage,
      metadata: request.metadata,
    };
  }
}
