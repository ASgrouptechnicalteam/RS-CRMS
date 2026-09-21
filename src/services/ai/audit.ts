/**
 * Phase 17-A — AI audit-field contract (normalized metadata only).
 *
 * Provides enough normalized fields for a future audit packet. This module stores
 * nothing. Explicitly prohibited to ever include: API keys, JWTs, passwords, credentials,
 * unrestricted KYC content, unrestricted sensitive prompts, or unrestricted sensitive
 * responses.
 */

import { AIErrorCategory, AIUsage } from './types';

export type AIAuditStatus = 'SUCCESS' | 'FAILURE';

export interface AIAuditRecord {
  requestId: string;
  correlationId: string | null;
  companyId: number;
  employeeId: number;
  provider: string;
  model: string;
  status: AIAuditStatus;
  latencyMs?: number;
  /** Normalized usage; never raw prompts/responses. */
  usage?: AIUsage | null;
  providerRequestId?: string;
  promptVersion: string;
  responseVersion: string;
  errorCategory?: AIErrorCategory;
}

export interface AIAuditHook {
  record(record: AIAuditRecord): void | Promise<void>;
}

/** Default no-op hook so the foundation works before an observability packet. */
export class NullAuditHook implements AIAuditHook {
  record(_record: AIAuditRecord): void {
    /* no-op */
  }
}