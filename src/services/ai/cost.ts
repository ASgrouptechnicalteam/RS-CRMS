/**
 * Phase 17-A — Cost-accounting hook interface.
 *
 * Provides only enough normalized usage information for a later packet to implement real
 * cost accounting. No billing, no database counters, no billing system.
 */

import { AIUsage } from './types';

export interface AICostHook {
  /** Called once per completed provider generation with normalized usage (may be null). */
  record(usage: AIUsage | null): void | Promise<void>;
}

/** Default no-op hook so the foundation runs without a cost system. */
export class NullCostHook implements AICostHook {
  record(_usage: AIUsage | null): void {
    /* no-op */
  }
}