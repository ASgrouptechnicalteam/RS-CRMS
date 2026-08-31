/**
 * Phase 17-D — AI Chat API contracts.
 *
 * The chat endpoint collects missing requirements from the user when a prior
 * /search extraction returned INCOMPLETE. It is a conversational wrapper around
 * the extraction envelope — it MUST NOT recommend properties, rank inventory,
 * or make booking/KYC decisions.
 *
 * The client owns the ephemeral conversation history and passes it in the
 * request together with the INCOMPLETE state. The server validates and
 * forwards it to the provider; no chat history is persisted in the CRM.
 */

import { z } from 'zod';
import { SearchIntentSchema, AmbiguitySchema, SearchIntent } from './searchIntent';

/**
 * System instructions confined to requirement gathering only.
 *
 * Sent as the system role for every chat request. Explicitly forbids property
 * recommendations, ranking, inventory discussion, match percentages, and any
 * CRM workflow beyond clarification. The AI must output ONLY structured JSON.
 */
export const DEFAULT_CHAT_SYSTEM_INSTRUCTIONS =
  'You are a polite, conversational clarification assistant for RRH-CRMS. ' +
  'Your ONLY job is to collect the missing property-search requirements from the ' +
  'user. You may ask follow-up questions, but you MUST NEVER: ' +
  '(1) recommend, rank, describe, or compare specific properties; ' +
  '(2) calculate match percentages, suitability scores, or discuss inventory ' +
  'availability or booking; ' +
  '(3) discuss KYC, payments, document verification, or any CRM workflow beyond ' +
  'requirement gathering. ' +
  'When the user has provided enough information to satisfy ALL missing ' +
  'requirements, output a JSON object with "status":"COMPLETE" and a valid ' +
  '"searchIntent" containing the finalized structured fields — and nothing else. ' +
  'If requirements are still missing after the user response, output a JSON ' +
  'object with "status":"INCOMPLETE", a "question" field containing your polite ' +
  'follow-up question, and an updated "missingRequirements" array. ' +
  'If the user asks about properties, recommendations, or anything outside ' +
  'requirement gathering, politely decline and redirect to asking for the ' +
  'missing requirements. ' +
  'Return ONLY valid JSON. Company scope, authorization, and tenant identity ' +
  'are already enforced outside this step.';

/** A single turn in the conversation history (client-managed, ephemeral). */
export const AIChatMessageSchema = z
  .object({
    role: z.enum(['user', 'assistant']),
    content: z.string().min(1).max(4000),
  })
  .strict();
export type AIChatMessage = z.infer<typeof AIChatMessageSchema>;

/**
 * The INCOMPLETE extraction state from a prior /search call.
 *
 * Only INCOMPLETE is accepted — chat never starts from a COMPLETE state.
 * Uses SearchIntentSchema's sub-schemas (AmbiguitySchema) for consistency.
 */
export const ChatIncompleteStateSchema = z
  .object({
    status: z.literal('INCOMPLETE'),
    missingRequirements: z.array(z.string().min(1)).max(16).optional(),
    ambiguities: z.array(AmbiguitySchema).max(8).optional(),
    unsupportedCriteria: z.array(z.string().min(1)).max(8).optional(),
    nextAction: z.literal('AI_CHAT').optional().default('AI_CHAT'),
  })
  .strict();

/**
 * Client request payload for the chat endpoint.
 *
 * Contains NO tenant fields; `.strict()` rejects injected tenant keys
 * (defense in depth — assertNoTenantOverride also runs server-side).
 */
export const AIChatRequestSchema = z
  .object({
    history: z.array(AIChatMessageSchema).min(1).max(50),
    incompleteState: ChatIncompleteStateSchema,
  })
  .strict();
export type AIChatRequest = z.infer<typeof AIChatRequestSchema>;

/**
 * Discriminated union of valid provider outputs for the chat endpoint.
 *
 * - CLARIFICATION (status INCOMPLETE): the AI asks a follow-up question.
 * - COMPLETE: the AI has gathered enough info and emits a finalized SearchIntent.
 *
 * The `searchIntent` inside COMPLETE is validated against the STRICT
 * `SearchIntentSchema` — no recommendation / ranking / match-percentage fields
 * can slip through.
 */
const ChatClarificationSchema = z
  .object({
    status: z.literal('INCOMPLETE'),
    question: z.string().min(1).max(2000),
    missingRequirements: z.array(z.string().min(1)).max(16).optional(),
  })
  .strict();

const ChatCompleteSchema = z
  .object({
    status: z.literal('COMPLETE'),
    searchIntent: SearchIntentSchema,
  })
  .strict();

export const ChatResponseSchema = z.discriminatedUnion('status', [
  ChatClarificationSchema,
  ChatCompleteSchema,
]);

/** Validated result returned by the chat service method. */
export type ChatResult =
  | {
      status: 'INCOMPLETE';
      question: string;
      missingRequirements: string[];
    }
  | {
      status: 'COMPLETE';
      searchIntent: SearchIntent;
    };

/** HTTP response envelope for the chat endpoint. */
export interface AIChatApiResponse {
  status: 'INCOMPLETE' | 'COMPLETE';
  nextAction: 'AI_CHAT' | 'CRM_SEARCH';
  question?: string;
  missingRequirements?: string[];
  searchIntent?: SearchIntent;
  /** Populated only when the chat resolves to COMPLETE and the CRM bridge runs. */
  results?: any[];
}

/** Map a validated ChatResult into the HTTP response envelope. */
export function buildChatApiResponse(result: ChatResult): AIChatApiResponse {
  if (result.status === 'INCOMPLETE') {
    return {
      status: 'INCOMPLETE',
      nextAction: 'AI_CHAT',
      question: result.question,
      missingRequirements: result.missingRequirements,
    };
  }
  return {
    status: 'COMPLETE',
    nextAction: 'CRM_SEARCH',
    searchIntent: result.searchIntent,
  };
}