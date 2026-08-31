"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SiteVisitPolicy = void 0;
const shared_1 = require("../shared");
class SiteVisitPolicy {
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
     * §2 / §8 item #1: "executive department" roles that may see the reassignment
     * `reason`. Confirmed narrow set: MD, Admin, Marketing Director only
     * (per spec §8 assumption, now ratified by user). Telecallers, PMs, Agents,
     * HR cannot inspect the reasoning behind a reassignment hop — same masking
     * pattern already used for employee PII.
     */
    static canViewReassignmentReason(user) {
        return user.roles.some((r) => [shared_1.Roles.MD, shared_1.Roles.ADMIN, shared_1.Roles.MARKETING_DIRECTOR].includes(r));
    }
    static canList(user) {
        const isManagement = this.isManagement(user);
        // Unconditional tenant isolation via explicit AND
        const whereCondition = {
            AND: [
                { lead: { company_id: user.companyId } }
            ]
        };
        if (!isManagement) {
            // Non-management restricted to their assigned visits, strictly within their company
            whereCondition.AND.push({
                OR: [
                    { telecaller_id: user.employeeId },
                    { assigned_agent_id: user.employeeId },
                    { project_manager_id: user.employeeId },
                ]
            });
        }
        return whereCondition;
    }
    static canCreate(user, lead) {
        if (!(user.permissions || []).includes(shared_1.Permissions.SITE_VISITS_CREATE)) {
            return false;
        }
        return lead.company_id === user.companyId;
    }
    static canVerify(user, visit) {
        if (!(user.permissions || []).includes(shared_1.Permissions.SITE_VISITS_VERIFY)) {
            return false;
        }
        return visit.lead.company_id === user.companyId;
    }
    static canAssignAgent(user, visit, agent) {
        if (!(user.permissions || []).includes(shared_1.Permissions.SITE_VISITS_ASSIGN_AGENT)) {
            return false;
        }
        if (visit.lead.company_id !== user.companyId) {
            return false;
        }
        if (agent && agent.company_id !== user.companyId) {
            return false; // Cross-company agent assignment not allowed
        }
        return true;
    }
    static canComplete(user, visit) {
        if (!(user.permissions || []).includes(shared_1.Permissions.SITE_VISITS_COMPLETE)) {
            return false;
        }
        if (visit.lead.company_id !== user.companyId) {
            return false;
        }
        // Fix IDOR: ensure the completing agent is the assigned agent, unless they are admin/management
        if (user.roles.includes(shared_1.Roles.MD) || user.roles.includes(shared_1.Roles.ADMIN)) {
            return true;
        }
        return visit.assigned_agent_id === user.employeeId;
    }
    /**
     * §2: only the PM/Agent the visit is currently routed to (PENDING_ACCEPTANCE)
     * may accept / reconfirm. For ACCEPTED visits, the assigned PM is the acceptor.
     */
    static canAccept(user, visit) {
        if (!(user.permissions || []).includes(shared_1.Permissions.SITE_VISITS_ASSIGN_AGENT)) {
            return false;
        }
        // The routed PM/Agent is the acceptor.
        return visit.project_manager_id === user.employeeId;
    }
    /**
     * §2 reassignment chain: only PROJECT_MANAGER and AGENT roles may be
     * reassignment targets — never Telecaller, HR, or any other role.
     */
    static canReassignTarget(user, target) {
        const targetRoles = target.roles
            ? target.roles
            : target.role
                ? [target.role]
                : [];
        return targetRoles.includes(shared_1.Roles.PROJECT_MANAGER) || targetRoles.includes(shared_1.Roles.AGENT);
    }
}
exports.SiteVisitPolicy = SiteVisitPolicy;
