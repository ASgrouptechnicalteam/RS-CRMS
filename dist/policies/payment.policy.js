"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PaymentPolicy = void 0;
const shared_1 = require("../shared");
/**
 * Phase 5 - Payment Resource Scope Policy
 * Enforces ownership and cross-company boundaries before mutating data.
 */
class PaymentPolicy {
    /**
     * Identifies if a user holds a management role with global payment access within their company.
     */
    static isManagement(user) {
        return user.roles.some((r) => [
            shared_1.Roles.MD,
            shared_1.Roles.ADMIN,
            shared_1.Roles.HR_MANAGER,
            shared_1.Roles.FINANCE,
            shared_1.Roles.MARKETING_DIRECTOR,
            shared_1.Roles.DIGITAL_LEAD_OPERATOR,
            shared_1.Roles.PROJECT_MANAGER,
        ].includes(r));
    }
    /**
     * Determines if the user is permitted to view the payment.
     * - Must belong to the same company.
     * - Management can view all payments in the company.
     * - Agents/Telecallers can only view payments they recorded.
     */
    static canView(user, payment) {
        if (payment.company_id !== user.companyId) {
            return false; // Never allow cross-company access
        }
        if (this.isManagement(user)) {
            return true;
        }
        // Agents can only see payments they recorded themselves (or we rely on Booking scope).
        return payment.recorded_by_id === user.employeeId;
    }
    /**
     * Determines if the user is permitted to mutate (update/cancel) the payment.
     * Note: SUCCESS/REFUNDED states shouldn't be mutated regardless of this policy.
     */
    static canMutate(user, payment) {
        return this.canView(user, payment);
    }
}
exports.PaymentPolicy = PaymentPolicy;
