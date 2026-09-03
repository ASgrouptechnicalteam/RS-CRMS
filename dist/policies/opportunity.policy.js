"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpportunityPolicy = void 0;
const shared_1 = require("../shared");
/**
 * Phase 8 - Opportunity Resource Scope Policy
 * Enforces ownership and cross-company boundaries before mutating data.
 */
class OpportunityPolicy {
    /**
     * Identifies if a user holds a management role with global opportunity access within the company.
     */
    static isManagement(user) {
        return user.roles.some((r) => [
            shared_1.Roles.MD,
            shared_1.Roles.ADMIN,
            shared_1.Roles.HR_MANAGER,
            shared_1.Roles.MARKETING_DIRECTOR,
            shared_1.Roles.PROJECT_MANAGER,
        ].includes(r));
    }
    /**
     * Generates a Prisma Prisma.OpportunityWhereInput condition for fetching opportunities safely.
     */
    static canList(user) {
        const isManagement = this.isManagement(user);
        // Unconditional tenant isolation via explicit AND
        const whereCondition = {
            AND: [
                { company_id: user.companyId }
            ]
        };
        if (!isManagement) {
            // Non-management restricted to their owned opportunities
            whereCondition.AND.push({
                owner_id: user.employeeId
            });
        }
        return whereCondition;
    }
    /**
     * Determines if the user is permitted to view the opportunity.
     */
    static canView(user, opp) {
        if (opp.company_id !== user.companyId) {
            return false; // Never allow cross-company access
        }
        if (this.isManagement(user)) {
            return true;
        }
        // Telecallers/Agents: Owned access only
        return opp.owner_id === user.employeeId;
    }
    /**
     * Determines if the user is permitted to mutate (update fields) the opportunity.
     */
    static canMutate(user, opp) {
        // Currently, mutation rules are identical to view rules for assigned users.
        return this.canView(user, opp);
    }
    /**
     * Determines if the user can transition the stage of the opportunity.
     */
    static canChangeStage(user, opp) {
        return this.canView(user, opp);
    }
}
exports.OpportunityPolicy = OpportunityPolicy;
