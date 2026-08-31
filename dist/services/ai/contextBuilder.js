"use strict";
/**
 * Phase 17-A — Prompt / context boundary (AI Search only).
 *
 * Distinguishes SYSTEM INSTRUCTIONS, USER INPUT, and RETRIEVED DATA. Retrieved CRM
 * content is explicitly marked and treated as untrusted DATA — never as authority over
 * system instructions, authorization, company scope, or CRM business rules.
 * This is NOT a general-purpose autonomous agent framework.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.AIContextBuilder = void 0;
class AIContextBuilder {
    build(input) {
        const messages = [
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
exports.AIContextBuilder = AIContextBuilder;
