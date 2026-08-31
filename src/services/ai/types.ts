/**
 * Phase 17-A — AI Foundation.
 *
 * Provider-independent AI contracts.
 *
 * These types are deliberately free of any provider-specific SDK types
 * (OpenAI, OpenRouter, Ollama, etc.). Application/domain code must depend only
 * on these contracts so that providers can be swapped, configured, or disabled
 * without touching feature logic.
 *
 * Security invariants (future packets enforce these):
 *   - `companyId` is ALWAYS derived from `req.user.companyId`; it is never taken
 *     from a request body/query, a client-supplied header, or a provider response.
 *   - Retrieved application content is DATA, never AUTHORITY.
 */

/**
 * A single message in a generation request.
 * `role` is intentionally restricted to a small, provider-independent set.
 */
export type AIMessageRole = 'system' | 'user' | 'assistant';

export interface AIMessage {
  role: AIMessageRole;
  /** Content is treated as DATA by default (never as system authority). */
  content: string;
  /** Optional faithful label indicating the content is user/retrieved data. */
  isRetrievedData?: boolean;
}

/** Provider-capability descriptor used to select/validate providers. */
export interface ProviderCapabilities {
  /** Provider identifier, e.g. 'mock' (never a client-controlled value at runtime). */
  provider: string;
  /** Whether the provider supports streaming. Foundation does not stream. */
  supportsStreaming: boolean;
  /** Maximum output tokens supported (per provider/model). */
  maxOutputTokens: number;
  /** Whether the provider supports usage accounting. */
  supportsUsage: boolean;
}

/** Deterministic request metadata bound to the authenticated caller's context. */
export interface AIRequestMetadata {
  requestId: string;
  correlationId: string;
  companyId: number;
  employeeId: number;
  promptVersion: string;
  responseVersion: string;
}

/** Generation request inputs; reselectable but validated before any provider call. */
export interface AIRequest {
  messages: AIMessage[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /** Provider selection override — RESTRICTED to internal/approved config only. */
  providerOverride?: string;
  metadata: AIRequestMetadata;
}

/** Normalized per-request usage metadata (provider-populated when supported). */
export interface AIUsage {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCost?: number;
}

/** Successful provider result. */
export interface AIResponse {
  content: string;
  model: string;
  usage: AIUsage | null;
  metadata: AIRequestMetadata;
}

/**
 * Normalized failure category so application code never depends on provider
 * internals. Anything not enumerated is surfaced as UNKNOWN_PROVIDER_ERROR and
 * treated as non-retryable-and-fail-closed by the gateway.
 */
export type AIErrorCategory =
  | 'TIMEOUT'
  | 'PROVIDER_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'MODEL_UNAVAILABLE'
  | 'INVALID_PROVIDER_RESPONSE'
  | 'INVALID_REQUEST'
  | 'QUOTA_EXCEEDED'
  | 'CONFIGURATION_ERROR'
  | 'UNKNOWN_PROVIDER_ERROR';

export interface AIProviderErrorInfo {
  category: AIErrorCategory;
  message: string;
  retryable: boolean;
  provider?: string;
}