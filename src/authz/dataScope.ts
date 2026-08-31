import { Prisma } from '@prisma/client';
import { TokenPayload } from '../utils/jwt';
import { Roles } from '../shared';
import { getDownstreamEmployeeIds } from '../utils/hierarchy';

const MANAGEMENT_ROLES = [
  Roles.MD,
  Roles.ADMIN,
  Roles.HR_MANAGER,
  Roles.MARKETING_DIRECTOR,
  Roles.DIGITAL_LEAD_OPERATOR,
  Roles.DIGITAL_MARKETING_HEAD,
  Roles.SALES_MANAGER,
];

/**
 * Ensures company isolation for all scopes, except for System Admins.
 */
function getBaseScope(user: TokenPayload): any {
  if (user.roles.includes(Roles.ADMIN)) {
    return {};
  }
  return { company_id: user.companyId };
}

/**
 * Builds the read-visibility scope for Leads.
 */
export async function buildLeadScope(user: TokenPayload): Promise<Prisma.LeadWhereInput> {
  const baseScope = getBaseScope(user);

  // 1. ADMIN
  if (user.roles.includes(Roles.ADMIN)) {
    return {}; // Global access
  }


  // 3. MANAGEMENT
  const isManagement = user.roles.some((r) => MANAGEMENT_ROLES.includes(r as any));
  if (isManagement) {
    return baseScope; // Entire company leads
  }

  // 4. MANAGERS & TELECALLERS (TEAM / OWN scope)
  const downstreamIds = await getDownstreamEmployeeIds(user.companyId, user.employeeId);
  return {
    ...baseScope,
    OR: [
      { assigned_to_id: { in: downstreamIds } },
      { created_by_id: { in: downstreamIds } },
    ],
  };
}

/**
 * Builds the read-visibility scope for Employees.
 */
export async function buildEmployeeScope(user: TokenPayload): Promise<Prisma.EmployeeWhereInput> {
  const baseScope = getBaseScope(user);

  // 1. ADMIN
  if (user.roles.includes(Roles.ADMIN)) {
    return {}; // Global access
  }


  // Hide system/invisible roles for everyone except Admin
  const invisibleFilter = {
    roles: { none: { role: { is_invisible: true } } },
  };

  // 3. MANAGEMENT
  const isManagement = user.roles.some((r) => [Roles.MD, Roles.HR_MANAGER].includes(r as any));
  if (isManagement) {
    return {
      ...baseScope,
      ...invisibleFilter,
    };
  }

  // 4. MANAGERS (TEAM scope) & STANDARD EMPLOYEES
  const downstreamIds = await getDownstreamEmployeeIds(user.companyId, user.employeeId);
  return {
    ...baseScope,
    ...invisibleFilter,
    id: { in: downstreamIds },
  };
}

/**
 * Builds the read-visibility scope for Properties.
 */
export async function buildPropertyScope(user: TokenPayload): Promise<Prisma.PropertyWhereInput> {
  const baseScope = getBaseScope(user);

  // 1. ADMIN & MANAGEMENT
  const isManagement = user.roles.some((r) => MANAGEMENT_ROLES.includes(r as any));
  if (user.roles.includes(Roles.ADMIN) || isManagement) {
    return baseScope;
  }

  // 2. PROJECT MANAGER
  if (user.roles.includes(Roles.PROJECT_MANAGER)) {
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

/**
 * Builds the read-visibility scope for Projects.
 *
 * Authorization per Phase 5 docs (03-project-level-authorization.md):
 *   ADMIN / MANAGEMENT:  all projects in company_id
 *   PROJECT_MANAGER:     ONLY explicitly assigned projects (assigned_pm_id = user.employeeId)
 *   TELECALLER / AGENT:  non-PLANNING, non-CANCELLED projects (for pitching)
 *   Others:              no access
 */
export async function buildProjectScope(user: TokenPayload): Promise<Prisma.ProjectWhereInput> {
  const baseScope = getBaseScope(user);

  // 1. ADMIN (global, no company restriction)
  if (user.roles.includes(Roles.ADMIN)) {
    return {};
  }

  // 2. MANAGEMENT (all company projects)
  const isManagement = user.roles.some((r) => MANAGEMENT_ROLES.includes(r as any));
  if (isManagement) {
    return baseScope;
  }

  // 3. PROJECT MANAGER — STRICTLY ASSIGNED PROJECTS ONLY
  // Per authoritative rule: PM CANNOT view Projects assigned to other PMs.
  if (user.roles.includes(Roles.PROJECT_MANAGER)) {
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

/**
 * Builds the read-visibility scope for Customers.
 */
export async function buildCustomerScope(user: TokenPayload): Promise<Prisma.CustomerWhereInput> {
  const baseScope = getBaseScope(user);

  if (user.roles.includes(Roles.ADMIN)) {
    return {};
  }

  const isManagement = user.roles.some((r) => MANAGEMENT_ROLES.includes(r as any));
  if (isManagement) {
    return baseScope;
  }

  const isProjectManager = user.roles.includes(Roles.PROJECT_MANAGER);
  if (isProjectManager) {
    return baseScope;
  }

  // Telecallers and Agents only see their assigned customers.
  return {
    ...baseScope,
    assigned_to_id: user.employeeId,
  };
}
