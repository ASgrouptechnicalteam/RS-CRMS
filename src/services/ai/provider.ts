/**
 * Phase 17-A — Provider boundary.
 *
 * `AIProvider` is the provider-independent interface. No OpenAI/OpenRouter/etc.
 * types appear here. Real providers (OpenAI, OpenRouter, Ollama, ...) are later
 * packets; 17-A ships only the interface + a deterministic mock.
 */

import {
  AIRequest,
  AIResponse,
  AIProviderErrorInfo,
  ProviderCapabilities,
} from './types';

/** Provider-facing failure signal. Providers throw this (or the gateway normalizes). */
export class AIProviderError extends Error {
  readonly info: AIProviderErrorInfo;
  constructor(info: AIProviderErrorInfo) {
    super(info.message);
    this.name = 'AIProviderError';
    this.info = info;
  }
}

export interface AIProvider {
  readonly capabilities: ProviderCapabilities;
  /** Perform a single generation request. Must resolve usage when supported. */
  generate(request: AIRequest): Promise<AIResponse>;
}
