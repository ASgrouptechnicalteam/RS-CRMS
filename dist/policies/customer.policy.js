"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CustomerPolicy = void 0;
const shared_1 = require("../shared");
/**
 * Phase 3 - Customer Resource Scope Policy
 * Enforces ownership and cross-company boundaries before mutating data.
 */
class CustomerPolicy {
    /**
     * Identifies if a user holds a management role with global customer access.
     */
    static isManagement(user) {
        return user.roles.some((r) => [
            shared_1.Roles.MD,
            shared_1.Roles.ADMIN,
            shared_1.Roles.HR_MANAGER,
            shared_1.Roles.MARKETING_DIRECTOR,
            shared_1.Roles.DIGITAL_LEAD_OPERATOR,
            shared_1.Roles.PROJECT_MANAGER,
        ].includes(r));
    }
    /**
     * Determines if the user is permitted to view the customer.
     * - Must belong to the same company.
     * - Management/PMs can view all customers in the company.
     * - Agents/Telecallers can only view customers assigned to them.
     */
    static canView(user, customer) {
        if (customer.company_id !== user.companyId) {
            return false; // Never allow cross-company access
        }
        if (this.isManagement(user)) {
            return true;
        }
        // Telecallers/Agents: Assigned access only
        return customer.assigned_to_id === user.employeeId;
    }
    /**
     * Determines if the user is permitted to mutate (update/convert) the customer.
     * - Applies the same rules as canView.
     */
    static canMutate(user, customer) {
        return this.canView(user, customer);
    }
}
exports.CustomerPolicy = CustomerPolicy;
