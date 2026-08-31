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

import { AIProvider } from './provider';
import { AIConfig, AIConfigError } from './config';
import { MockProvider } from './mockProvider';
import { OPENROUTER_PROVIDER, OpenRouterProvider } from './openRouterProvider';

function requireOpenRouterKey(): string {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key || key.trim() === '') {
    throw new AIConfigError('OPENROUTER_API_KEY is required when AI_PROVIDER=openrouter.');
  }
  return key.trim();
}

function requireModel(config: AIConfig): string {
  if (!config.model || config.model.trim() === '') {
    throw new AIConfigError('AI_MODEL is required when AI_PROVIDER=openrouter.');
  }
  return config.model.trim();
}

export function createAIProvider(config: AIConfig): AIProvider {
  const name = (config.provider || '').trim().toLowerCase();

  if (name === '' || name === 'mock') {
    return new MockProvider();
  }

  if (name === OPENROUTER_PROVIDER) {
    return new OpenRouterProvider({ apiKey: requireOpenRouterKey(), model: requireModel(config) });
  }

  throw new AIConfigError(`Unsupported AI_PROVIDER '${config.provider}'. Supported: mock, openrouter.`);
}