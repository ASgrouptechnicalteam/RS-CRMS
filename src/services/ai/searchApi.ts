/**
 * Phase 17-B — AI Search API contracts.
 *
 * The request is intentionally strict: the client may provide ONLY a `query`. It may never
 * supply tenant/company/employee/role/permission/scope/provider/model/API-key/system-prompt/
 * tools/SQL — any unexpected field is rejected before reaching the provider.
 *
 * The response is a machine-readable COMPLETE / INCOMPLETE envelope and never carries
 * properties, match %, ranking, recommendations, provider details, API keys, or tenant ids.
 */

import { z } from 'zod';
import { SearchIntentExtraction } from './searchIntent';

/** Server-side maximum query length (repository has no tighter constraint; do not rely on the client). */
export const AI_REQUEST_QUERY_MAX = 4000;

export const AISearchRequestSchema = z
  .object({
    query: z.string().min(1, 'query is required').max(AI_REQUEST_QUERY_MAX),
  })
  .strict();

export type AISearchRequest = z.infer<typeof AISearchRequestSchema>;

export interface AISearchApiResponse {
  status: 'COMPLETE' | 'INCOMPLETE';
  searchIntent?: any;
  missingRequirements?: string[];
  ambiguities?: any[];
  unsupportedCriteria?: string[];
  nextAction: 'CRM_SEARCH' | 'AI_CHAT';
  /**
   * Populated ONLY on a COMPLETE extraction after the deterministic CRM property search
   * (Phase 17-C bridge) runs. This is the CRM's authority, not the AI's — the AI never
   * decides matches. Absent when the CRM search is not invoked.
   */
  results?: any[];
}

/**
 * Map the validated extraction into the HTTP response envelope.
 * AI's responsibility ends at SearchIntent; CRM handles deterministic search (Phase 17-C).
 */
export function buildSearchApiResponse(extraction: SearchIntentExtraction): AISearchApiResponse {
  if (extraction.status === 'COMPLETE') {
    return {
      status: 'COMPLETE',
      searchIntent: extraction.searchIntent,
      nextAction: 'CRM_SEARCH',
    };
  }
  return {
    status: 'INCOMPLETE',
    missingRequirements: extraction.missingRequirements ?? [],
    ambiguities: extraction.ambiguities ?? [],
    unsupportedCriteria: extraction.unsupportedCriteria ?? [],
    nextAction: 'AI_CHAT',
  };
}