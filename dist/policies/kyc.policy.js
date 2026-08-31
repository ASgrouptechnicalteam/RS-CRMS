"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.KycPolicy = void 0;
const shared_1 = require("../shared");
// KYC-authorized tier (Phase 11). Note: KYC status is now owned by
// by the customer portal and surfaces back via IntegrationService.processKycCallback.
const KYC_AUTHORIZED_ROLES = [
    shared_1.Roles.MD,
    shared_1.Roles.ADMIN,
    shared_1.Roles.HR_MANAGER,
    shared_1.Roles.FINANCE,
];
/**
 * Phase 11 Packet 3C - Customer KYC Resource Scope Policy.
 * Enforces the CUSTOMERS_KYC_WRITE permission and hard company boundaries
 * before any mutation of HIGH-class customer KYC data.
 */
class KycPolicy {
    static isKYCRole(user) {
        return user.roles.some((r) => KYC_AUTHORIZED_ROLES.includes(r));
    }
    static canWrite(user, customer) {
        if (!(user.permissions || []).includes(shared_1.Permissions.CUSTOMERS_KYC_WRITE)) {
            return false;
        }
        if (customer.company_id !== user.companyId) {
            return false; // Never allow cross-company KYC access (customer.policy.ts:33-35 pattern)
        }
        return true;
    }
}
exports.KycPolicy = KycPolicy;
