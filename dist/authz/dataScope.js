"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildCustomerScope = exports.buildProjectScope = exports.buildPropertyScope = exports.buildEmployeeScope = exports.buildLeadScope = void 0;
const shared_1 = require("../shared");
const hierarchy_1 = require("../utils/hierarchy");
const MANAGEMENT_ROLES = [
    shared_1.Roles.MD,
    shared_1.Roles.ADMIN,
    shared_1.Roles.HR_MANAGER,
    shared_1.Roles.MARKETING_DIRECTOR,
    shared_1.Roles.DIGITAL_LEAD_OPERATOR,
    shared_1.Roles.DIGITAL_MARKETING_HEAD,
    shared_1.Roles.SALES_MANAGER,
];
/**
 * Ensures company isolation for all scopes, except for System Admins.
 */
function getBaseScope(user) {
    if (user.roles.includes(shared_1.Roles.ADMIN)) {
        return {};
    }
    return { company_id: user.companyId };
}
/**
 * Builds the read-visibility scope for Leads.
 */
async function buildLeadScope(user) {
    const baseScope = getBaseScope(user);
    // 1. ADMIN
    if (user.roles.includes(shared_1.Roles.ADMIN)) {
        return {}; // Global access
    }
    // 3. MANAGEMENT
    const isManagement = user.roles.some((r) => MANAGEMENT_ROLES.includes(r));
    if (isManagement) {
        return baseScope; // Entire company leads
    }
    // 4. MANAGERS & TELECALLERS (TEAM / OWN scope)
    const downstreamIds = await (0, hierarchy_1.getDownstreamEmployeeIds)(user.companyId, user.employeeId);
    return {
        ...baseScope,
        OR: [
            { assigned_to_id: { in: downstreamIds } },
            { created_by_id: { in: downstreamIds } },
        ],
    };
}
exports.buildLeadScope = buildLeadScope;
/**
 * Builds the read-visibility scope for Employees.
 */
async function buildEmployeeScope(user) {
    const baseScope = getBaseScope(user);
    // 1. ADMIN
    if (user.roles.includes(shared_1.Roles.ADMIN)) {
        return {}; // Global access
    }
    // Hide system/invisible roles for everyone except Admin
    const invisibleFilter = {
        roles: { none: { role: { is_invisible: true } } },
    };
    // 3. MANAGEMENT
    const isManagement = user.roles.some((r) => [shared_1.Roles.MD, shared_1.Roles.HR_MANAGER].includes(r));
    if (isManagement) {
        return {
            ...baseScope,
            ...invisibleFilter,
        };
    }
    // 4. MANAGERS (TEAM scope) & STANDARD EMPLOYEES
    const downstreamIds = await (0, hierarchy_1.getDownstreamEmployeeIds)(user.companyId, user.employeeId);
    return {
        ...baseScope,
        ...invisibleFilter,
        id: { in: downstreamIds },
    };
}
exports.buildEmployeeScope = buildEmployeeScope;
/**
 * Builds the read-visibility scope for Properties.
 */
async function buildPropertyScope(user) {
    const baseScope = getBaseScope(user);
    // 1. ADMIN & MANAGEMENT
    const isManagement = user.roles.some((r) => MANAGEMENT_ROLES.includes(r));
    if (user.roles.includes(shared_1.Roles.ADMIN) || isManagement) {
        return baseScope;
    }
    // 2. PROJECT MANAGER
    if (user.roles.includes(shared_1.Roles.PROJECT_MANAGER)) {
        return {
            ...baseScope,
            OR: [
                { assigned_pm_id: user.employeeId },
                { status: 'LIVE' },
            ],
        };
    }
    // 3. TELECALLER, AGENT
    // Default to LIVE properties only within their company.
    return {
        ...baseScope,
        status: 'LIVE',
    };
}
exports.buildPropertyScope = buildPropertyScope;
/**
 * Builds the read-visibility scope for Projects.
 *
 * Authorization per Phase 5 docs (03-project-level-authorization.md):
 *   ADMIN / MANAGEMENT:  all projects in company_id
 *   PROJECT_MANAGER:     ONLY explicitly assigned projects (assigned_pm_id = user.employeeId)
 *   TELECALLER / AGENT:  non-PLANNING, non-CANCELLED projects (for pitching)
 *   Others:              no access
 */
async function buildProjectScope(user) {
    const baseScope = getBaseScope(user);
    // 1. ADMIN (global, no company restriction)
    if (user.roles.includes(shared_1.Roles.ADMIN)) {
        return {};
    }
    // 2. MANAGEMENT (all company projects)
    const isManagement = user.roles.some((r) => MANAGEMENT_ROLES.includes(r));
    if (isManagement) {
        return baseScope;
    }
    // 3. PROJECT MANAGER — STRICTLY ASSIGNED PROJECTS ONLY
    // Per authoritative rule: PM CANNOT view Projects assigned to other PMs.
    if (user.roles.includes(shared_1.Roles.PROJECT_MANAGER)) {
        return {
            ...baseScope,
            assigned_pm_id: user.employeeId,
        };
    }
    // 4. TELECALLER / AGENT — read-only, launched projects (UNDER_CONSTRUCTION or COMPLETED)
    // Note: Project has no 'LIVE' status. 'LIVE' in roadmap documentation maps to
    // non-PLANNING, non-CANCELLED projects. This interpretation is confirmed by
    // the Packet 3 telecaller scope business decision.
    return {
        ...baseScope,
        status: { notIn: ['PLANNING', 'CANCELLED'] },
    };
}
exports.buildProjectScope = buildProjectScope;
/**
 * Builds the read-visibility scope for Customers.
 */
async function buildCustomerScope(user) {
    const baseScope = getBaseScope(user);
    if (user.roles.includes(shared_1.Roles.ADMIN)) {
        return {};
    }
    const isManagement = user.roles.some((r) => MANAGEMENT_ROLES.includes(r));
    if (isManagement) {
        return baseScope;
    }
    const isProjectManager = user.roles.includes(shared_1.Roles.PROJECT_MANAGER);
    if (isProjectManager) {
        return baseScope;
    }
    // Telecallers and Agents only see their assigned customers.
    return {
        ...baseScope,
        assigned_to_id: user.employeeId,
    };
}
exports.buildCustomerScope = buildCustomerScope;
