"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildSearchApiResponse = exports.AISearchRequestSchema = exports.AI_REQUEST_QUERY_MAX = void 0;
const zod_1 = require("zod");
/** Server-side maximum query length (repository has no tighter constraint; do not rely on the client). */
exports.AI_REQUEST_QUERY_MAX = 4000;
exports.AISearchRequestSchema = zod_1.z
    .object({
    query: zod_1.z.string().min(1, 'query is required').max(exports.AI_REQUEST_QUERY_MAX),
})
    .strict();
/**
 * Map the validated extraction into the HTTP response envelope.
 * AI's responsibility ends at SearchIntent; CRM handles deterministic search (Phase 17-C).
 */
function buildSearchApiResponse(extraction) {
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
exports.buildSearchApiResponse = buildSearchApiResponse;
