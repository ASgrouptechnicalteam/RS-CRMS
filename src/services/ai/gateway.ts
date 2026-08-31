/**
 * Phase 17-A — AI gateway: timeout + bounded retry + normalized error surface.
 *
 * The core application layer depends only on this gateway, never on provider SDKs.
 * Retries apply ONLY to retryable provider failures and respect the configured maximum;
 * invalid requests and unknown errors fail closed (no infinite retry loops).
 */

import { AIProvider, AIProviderError } from './provider';
import {
  AIErrorCategory,
  AIProviderErrorInfo,
  AIRequest,
  AIResponse,
  AIUsage,
} from './types';
import { AIConfig } from './config';
import { AICostHook, NullCostHook } from './cost';
import { AIAuditHook, AIAuditRecord, NullAuditHook } from './audit';

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(
          new AIProviderError({
            category: 'TIMEOUT',
            message: `Provider did not respond within ${timeoutMs}ms`,
            retryable: true,
          })
        );
      }
    }, timeoutMs);

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/** Normalize any thrown value into a provider-independent AIProviderErrorInfo. */
function normalizeError(err: any, provider: string): AIProviderErrorInfo {
  if (err instanceof AIProviderError) return err.info;

  const candidate = (err as { info?: any })?.info;
  if (
    candidate &&
    typeof candidate === 'object' &&
    'category' in (candidate as Record<string, unknown>)
  ) {
    return candidate as AIProviderErrorInfo;
  }

  return {
    category: 'UNKNOWN_PROVIDER_ERROR',
    message: err instanceof Error ? err.message : 'Unknown provider error',
    retryable: false,
    provider,
  };
}

export interface AIGatewayDeps {
  provider: AIProvider;
  config: AIConfig;
  costHook?: AICostHook;
  auditHook?: AIAuditHook;
}

export class AIGateway {
  private readonly costHook: AICostHook;
  private readonly auditHook: AIAuditHook;

  constructor(private readonly deps: AIGatewayDeps) {
    this.costHook = deps.costHook ?? new NullCostHook();
    this.auditHook = deps.auditHook ?? new NullAuditHook();
  }

  async generate(request: AIRequest): Promise<AIResponse> {
    const provider = this.deps.provider;
    const maxAttempts = this.deps.config.maxRetries + 1;
    const startedAt = Date.now();
    let last: AIProviderErrorInfo | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const response = await withTimeout(
          this.deps.provider.generate(request),
          this.deps.config.timeoutMs
        );
        const latencyMs = Date.now() - startedAt;
        this.auditHook.record(
          this.auditRecord(request, 'SUCCESS', latencyMs, response.usage)
        );
        this.costHook.record(response.usage);
        return response;
      } catch (err) {
        const info = normalizeError(err, provider.capabilities.provider);
        last = info;
        this.auditHook.record(
          this.auditRecord(request, 'FAILURE', Date.now() - startedAt, undefined, info.category)
        );
        const exhausted = attempt >= maxAttempts - 1;
        if (!info.retryable || exhausted) {
          throw new AIProviderError(info);
        }
      }
    }

    throw new AIProviderError(
      last ?? { category: 'UNKNOWN_PROVIDER_ERROR', message: 'No provider attempt occurred', retryable: false }
    );
  }

  private auditRecord(
    request: AIRequest,
    status: AIAuditRecord['status'],
    latencyMs: number,
    usage?: AIUsage | null,
    errorCategory?: AIAuditRecord['errorCategory']
  ): AIAuditRecord {
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