"use strict";
/**
 * Phase 17-A — Cost-accounting hook interface.
 *
 * Provides only enough normalized usage information for a later packet to implement real
 * cost accounting. No billing, no database counters, no billing system.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.NullCostHook = void 0;
/** Default no-op hook so the foundation runs without a cost system. */
class NullCostHook {
    record(_usage) {
        /* no-op */
    }
}
exports.NullCostHook = NullCostHook;
