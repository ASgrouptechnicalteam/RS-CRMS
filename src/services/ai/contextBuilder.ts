/**
 * Phase 17-A — Prompt / context boundary (AI Search only).
 *
 * Distinguishes SYSTEM INSTRUCTIONS, USER INPUT, and RETRIEVED DATA. Retrieved CRM
 * content is explicitly marked and treated as untrusted DATA — never as authority over
 * system instructions, authorization, company scope, or CRM business rules.
 * This is NOT a general-purpose autonomous agent framework.
 */

import { AIMessage } from './types';

export interface RetrievedField {
  /** What the content is (e.g. 'property', 'lead-qualification-document'). */
  kind: string;
  /** Untrusted retrieved CRM content, already company-scoped by the caller. */
  content: string;
}

export interface AIBuildContext {
  instructions: string;
  query: string;
  retrieved: RetrievedField[];
}

export class AIContextBuilder {
  build(input: AIBuildContext): AIMessage[] {
    const messages: AIMessage[] = [
      { role: 'system', content: input.instructions },
      { role: 'user', content: input.query },
    ];

    for (const field of input.retrieved || []) {
      messages.push({
        role: 'user',
        content: `Retrieved ${field.kind}: ${field.content}`,
        isRetrievedData: true,
      });
    }

    return messages;
  }
}