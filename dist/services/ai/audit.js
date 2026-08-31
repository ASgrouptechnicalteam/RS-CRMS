"use strict";
/**
 * Phase 17-A — AI audit-field contract (normalized metadata only).
 *
 * Provides enough normalized fields for a future audit packet. This module stores
 * nothing. Explicitly prohibited to ever include: API keys, JWTs, passwords, credentials,
 * unrestricted KYC content, unrestricted sensitive prompts, or unrestricted sensitive
 * responses.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.NullAuditHook = void 0;
/** Default no-op hook so the foundation works before an observability packet. */
class NullAuditHook {
    record(_record) {
        /* no-op */
    }
}
exports.NullAuditHook = NullAuditHook;
