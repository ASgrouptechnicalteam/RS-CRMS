"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProjectPolicy = void 0;
const shared_1 = require("../shared");
/**
 * Phase 5 Packet 3 — ProjectPolicy
 *
 * Enforces object-level authorization for Project resources.
 *
 * Authorization rules per Phase 5 authoritative documentation:
 * - docs/archive/2026-08/roadmap/phase-5/03-project-level-authorization.md
 * - docs/archive/2026-08/roadmap/phase-5/06-phase-5-acceptance-criteria.md
 *
 * ADMIN / MD / MANAGEMENT: Full visibility and mutation rights within company_id.
 * PROJECT_MANAGER: Only projects explicitly assigned to them (assigned_pm_id = user.employeeId).
 * TELECALLER / AGENT: Read-only on launched projects (no write rights).
 */
class ProjectPolicy {
    static isManagement(user) {
        return user.roles.some((r) => [
            shared_1.Roles.MD,
            shared_1.Roles.ADMIN,
            shared_1.Roles.HR_MANAGER,
            shared_1.Roles.MARKETING_DIRECTOR,
            shared_1.Roles.DIGITAL_LEAD_OPERATOR,
            shared_1.Roles.DIGITAL_MARKETING_HEAD,
        ].includes(r));
    }
    /**
     * Determines whether a user may read (view) a specific Project.
     * - Management: may read any project in their company.
     * - Project Manager: may only read projects explicitly assigned to them.
     * - Telecaller/Agent: may read non-PLANNING, non-CANCELLED projects (read-only for pitching).
     */
    static canRead(user, project) {
        // Cross-company access is always forbidden (except Admin who has no company_id restriction)
        if (!user.roles.includes(shared_1.Roles.ADMIN) && project.company_id !== user.companyId) {
            return false;
        }
        // Admin: global access
        if (user.roles.includes(shared_1.Roles.ADMIN)) {
            return true;
        }
        // Management: full company visibility
        if (this.isManagement(user)) {
            return true;
        }
        // Project Manager: ONLY explicitly assigned projects
        if (user.roles.includes(shared_1.Roles.PROJECT_MANAGER)) {
            return project.assigned_pm_id === user.employeeId;
        }
        // Telecaller / Agent: read launched projects (UNDER_CONSTRUCTION or COMPLETED)
        if (user.roles.includes(shared_1.Roles.TELECALLER) || user.roles.includes(shared_1.Roles.AGENT)) {
            return !['PLANNING', 'CANCELLED'].includes(project.status);
        }
        // All others: no access
        return false;
    }
    /**
     * Determines whether a user may create a Project.
     * Only roles with PROJECTS_CREATE permission.
     */
    static canCreate(user) {
        return (user.permissions || []).includes(shared_1.Permissions.PROJECTS_CREATE);
    }
    /**
     * Determines whether a user may update a specific Project.
     * - Management: may update any project in their company.
     * - Project Manager: may ONLY update projects explicitly assigned to them.
     * - Telecaller/Agent: NO write access to projects.
     */
    static canUpdate(user, project) {
        if (!(user.permissions || []).includes(shared_1.Permissions.PROJECTS_UPDATE)) {
            return false;
        }
        if (!user.roles.includes(shared_1.Roles.ADMIN) && project.company_id !== user.companyId) {
            return false;
        }
        if (user.roles.includes(shared_1.Roles.ADMIN))
            return true;
        if (this.isManagement(user))
            return true;
        // Project Manager: assignment-based
        if (user.roles.includes(shared_1.Roles.PROJECT_MANAGER)) {
            return project.assigned_pm_id === user.employeeId;
        }
        return false;
    }
    /**
     * Determines whether a user may delete (archive/cancel) a specific Project.
     * Same rules as canUpdate.
     */
    static canDelete(user, project) {
        if (!(user.permissions || []).includes(shared_1.Permissions.PROJECTS_DELETE)) {
            return false;
        }
        if (!user.roles.includes(shared_1.Roles.ADMIN) && project.company_id !== user.companyId) {
            return false;
        }
        if (user.roles.includes(shared_1.Roles.ADMIN))
            return true;
        if (this.isManagement(user))
            return true;
        // Project Manager: assignment-based
        if (user.roles.includes(shared_1.Roles.PROJECT_MANAGER)) {
            return project.assigned_pm_id === user.employeeId;
        }
        return false;
    }
}
exports.ProjectPolicy = ProjectPolicy;
