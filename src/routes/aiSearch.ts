import { logger } from '../utils/logger';
/**
 * Phase 17-B/17-D — AI Search + AI Chat API routes.
 *
 * Search flow: authenticateToken → aiSearchLimiter → requireAuthz(AI_SEARCH) →
 *   validateRequestBody(AISearchRequestSchema) → SearchIntentService.extract
 *   (server-derived req.user.companyId) → COMPLETE/INCOMPLETE.
 *
 * Chat flow (Phase 17-D): authenticateToken → aiSearchLimiter →
 *   requireAuthz(AI_SEARCH) → validateRequestBody(AIChatRequestSchema) →
 *   SearchIntentService.chat → CLARIFICATION or COMPLETE SearchIntent.
 *
 * The AI's responsibility ends at SearchIntent — CRM performs deterministic
 * filtering, matching, scoring and ranking (Phase 17-C). The client can never
 * control tenant identity, provider, model, credentials, permissions, or tools.
 * Chat history is ephemeral (client-managed); nothing is persisted server-side.
 */

import { Router, Response } from 'express';
import { Permissions } from '../shared';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { requireAuthz } from '../middleware/authz';
import { validateRequestBody } from '../middleware/validate';
import { aiSearchLimiter } from '../middleware/rateLimiter';
import { AISearchRequestSchema, buildSearchApiResponse } from '../services/ai/searchApi';
import { AIConfig, AIConfigError } from '../services/ai/config';
import { createAIProvider } from '../services/ai/providerFactory';
import { AIProviderError } from '../services/ai/provider';
import { InvalidSearchIntentError } from '../services/ai/searchIntent';
import { searchCrmMatches, CRMSearchError } from '../services/ai/searchIntentBridge';
import {
  SearchIntentService,
  AITenantOverrideError,
  InvalidAIInputError,
  InvalidAIStructuredOutputError,
  InvalidChatInputError,
  AuthenticatedAICaller,
} from '../services/ai/application';
import { AIChatRequestSchema, buildChatApiResponse } from '../services/ai/chatApi';

function mapAIError(err: any, res: Response): void {
  if (err instanceof AIProviderError) {
    const table: Record<string, { status: number; code: string }> = {
      TIMEOUT: { status: 504, code: 'TIMEOUT' },
      RATE_LIMITED: { status: 429, code: 'RATE_LIMITED' },
      QUOTA_EXCEEDED: { status: 429, code: 'QUOTA_EXCEEDED' },
      PROVIDER_UNAVAILABLE: { status: 502, code: 'PROVIDER_UNAVAILABLE' },
      INVALID_PROVIDER_RESPONSE: { status: 502, code: 'INVALID_PROVIDER_RESPONSE' },
      MODEL_UNAVAILABLE: { status: 502, code: 'MODEL_UNAVAILABLE' },
      INVALID_REQUEST: { status: 400, code: 'INVALID_REQUEST' },
      CONFIGURATION_ERROR: { status: 500, code: 'CONFIGURATION_ERROR' },
      UNKNOWN_PROVIDER_ERROR: { status: 502, code: 'UPSTREAM_ERROR' },
    };
    const mapped = table[err.info.category] ?? { status: 502, code: 'UPSTREAM_ERROR' };
    res.status(mapped.status).json({
      error: mapped.status >= 500 ? 'AI service temporarily unavailable' : 'AI request could not be completed',
      code: mapped.code,
    });
    return;
  }

  if (err instanceof InvalidAIStructuredOutputError || err instanceof InvalidSearchIntentError) {
    res.status(422).json({ error: 'AI returned invalid structured output', code: 'INVALID_AI_OUTPUT' });
    return;
  }

  if (err instanceof AITenantOverrideError || err instanceof InvalidAIInputError || err instanceof InvalidChatInputError) {
    res.status(400).json({ error: 'Invalid AI request', code: 'INVALID_REQUEST' });
    return;
  }

  if (err instanceof AIConfigError) {
    res.status(500).json({ error: 'AI is not configured correctly', code: 'CONFIGURATION_ERROR' });
    return;
  }

  if (err instanceof CRMSearchError) {
    res.status(502).json({ error: 'CRM property search failed', code: 'CRM_SEARCH_ERROR' });
    return;
  }

  if (err && (err as { statusCode?: number }).statusCode) {
    const status = (err as { statusCode: number }).statusCode;
    if (status >= 500) {
      logger.error('[ai-search]', err);
      res.status(status).json({ error: 'Internal Server Error', code: 'INTERNAL_ERROR' });
      return;
    }
    res.status(status).json({ error: 'Invalid request', code: 'INVALID_REQUEST' });
    return;
  }

  logger.error('[ai-search]', err);
  res.status(500).json({ error: 'Internal Server Error', code: 'INTERNAL_ERROR' });
}

function defaultService(): SearchIntentService {
  const config = AIConfig.fromEnv();
  return new SearchIntentService({ provider: createAIProvider(config), config });
}

export function createAISearchRouter(service?: SearchIntentService): Router {
  const router = Router();
  const svc = service ?? defaultService();

  router.post(
    '/search',
    authenticateToken,
    aiSearchLimiter,
    requireAuthz(Permissions.AI_SEARCH),
    validateRequestBody(AISearchRequestSchema),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const caller: AuthenticatedAICaller = {
          companyId: req.user!.companyId,
          employeeId: req.user!.employeeId,
        };
        const extraction = await svc.extract(req.body, caller);
        const response = buildSearchApiResponse(extraction);

        // Phase 17-C: the deterministic CRM bridge decides what matches (never the AI).
        // companyId is the authenticated caller's — client can never control it.
        if (extraction.status === 'COMPLETE' && extraction.searchIntent) {
          try {
            response.results = await searchCrmMatches(extraction.searchIntent, caller.companyId);
          } catch (crmErr) {
            mapAIError(new CRMSearchError('CRM property search failed'), res);
            return;
          }
        }

        res.status(200).json(response);
      } catch (err) {
        mapAIError(err, res);
      }
    }
  );

  // Phase 17-D — POST /api/v1/ai/chat
  // Flow: authenticateToken → aiSearchLimiter → requireAuthz(AI_SEARCH) →
  //   validateRequestBody(AIChatRequestSchema) → SearchIntentService.chat
  //   (server-derived req.user.companyId) → CLARIFICATION or COMPLETE SearchIntent.
  // On COMPLETE, the deterministic 17-C CRM bridge runs and returns results.
  // The conversation is ephemeral (client-managed) — nothing is persisted here.
  router.post(
    '/chat',
    authenticateToken,
    aiSearchLimiter,
    requireAuthz(Permissions.AI_SEARCH),
    validateRequestBody(AIChatRequestSchema),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const caller: AuthenticatedAICaller = {
          companyId: req.user!.companyId,
          employeeId: req.user!.employeeId,
        };
        const chatResult = await svc.chat(req.body, caller);
        const response = buildChatApiResponse(chatResult);

        // Phase 17-C: when the chat resolves to COMPLETE, the deterministic CRM
        // bridge decides matches (never the AI). companyId stays server-derived.
        if (chatResult.status === 'COMPLETE' && chatResult.searchIntent) {
          try {
            response.results = await searchCrmMatches(chatResult.searchIntent, caller.companyId);
          } catch (crmErr) {
            mapAIError(new CRMSearchError('CRM property search failed'), res);
            return;
          }
        }

        res.status(200).json(response);
      } catch (err) {
        mapAIError(err, res);
      }
    }
  );

  return router;
}

export default createAISearchRouter();
