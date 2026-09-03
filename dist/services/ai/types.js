"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
