import { TokenPayload } from '../utils/jwt';
import { Roles, Permissions } from '../shared';

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
/**
 * Project.verification_status values before the MD approves (VERIFIED). A
 * Digital Marketing Executive may edit a project they created or are assigned
 * only while it is in one of these (item 3, 2026-11-15). Unknown => locked.
 */
export const DM_EXECUTIVE_EDITABLE_PROJECT = [
  'DRAFT',
  'PENDING_VERIFICATION',
  'PENDING_DM_EXEC',
  'PENDING_DM_POLISH',
  'PENDING_MD_APPROVAL',
  'REJECTED',
];

export class ProjectPolicy {
  /**
   * Who may type in a project's main details (plots/flats, availability, sizes, BHK types, starting price):
   * the MD, Admin, the Technical Manager, the digital team (2026-11-27), and the PM this project is assigned
   * to (not any other PM).
   */
  static canEditKeyDetails(
    user: { employeeId: number; roles: string[] },
    project: { assigned_pm_id?: number | null },
  ): boolean {
    const always: string[] = [
      Roles.MD,
      Roles.ADMIN,
      Roles.TECHNICAL_MANAGER,
      Roles.DIGITAL_MARKETING_HEAD,
      Roles.DIGITAL_MARKETING_EXECUTIVE,
    ];
    if (user.roles.some((r) => always.includes(r))) return true;
    return (
      user.roles.includes(Roles.PROJECT_MANAGER) &&
      project.assigned_pm_id != null &&
      project.assigned_pm_id === user.employeeId
    );
  }

  /**
   * A Project Manager "owns" a record when it is assigned to them, or when
   * they created it and nobody has been assigned yet -- without the second
   * case a PM who creates something with no PM set could not edit their own
   * new record.
   */
  private static isOwningPm(
    user: TokenPayload,
    rec: { assigned_pm_id: number | null; created_by_id?: number | null },
  ): boolean {
    if (rec.assigned_pm_id === user.employeeId) return true;
    return rec.assigned_pm_id == null && rec.created_by_id === user.employeeId;
  }

  private static isManagement(user: TokenPayload): boolean {
    return user.roles.some((r) =>
      [
        Roles.MD,
        Roles.ADMIN,
        Roles.HR_MANAGER,
        Roles.MARKETING_DIRECTOR,
        Roles.DIGITAL_LEAD_OPERATOR,
        Roles.DIGITAL_MARKETING_HEAD,
      ].includes(r as any),
    );
  }

  /**
   * NOT what decides who can see a project: routes apply object policies only
   * for writes (middleware/authz.ts), and reads follow buildProjectScope in
   * authz/dataScope.ts (e.g. a Telecaller sees every VERIFIED project, PLANNING
   * included). Kept for reference only — don't rely on it for access checks.
   *
   * Determines whether a user may read (view) a specific Project.
   * - Management: may read any project in their company.
   * - Project Manager: may only read projects explicitly assigned to them.
   * - Telecaller/Agent: may read non-PLANNING, non-CANCELLED projects (read-only for pitching).
   */
  static canRead(
    user: TokenPayload,
    project: { company_id: number; assigned_pm_id: number | null; status: string },
  ): boolean {
    // Cross-company access is always forbidden (except Admin who has no company_id restriction)
    if (!user.roles.includes(Roles.ADMIN) && project.company_id !== user.companyId) {
      return false;
    }

    // Admin: global access
    if (user.roles.includes(Roles.ADMIN)) {
      return true;
    }

    // Management: full company visibility
    if (this.isManagement(user)) {
      return true;
    }

    // Project Manager: ONLY explicitly assigned projects
    if (user.roles.includes(Roles.PROJECT_MANAGER)) {
      return this.isOwningPm(user, project);
    }

    // Telecaller / Agent: read launched projects (UNDER_CONSTRUCTION or COMPLETED)
    if (user.roles.includes(Roles.TELECALLER) || user.roles.includes(Roles.AGENT)) {
      return !['PLANNING', 'CANCELLED'].includes(project.status);
    }

    // All others: no access
    return false;
  }

  /**
   * Determines whether a user may create a Project.
   * Only roles with PROJECTS_CREATE permission.
   */
  static canCreate(user: TokenPayload): boolean {
    return (user.permissions || []).includes(Permissions.PROJECTS_CREATE);
  }

  /**
   * The Marketing Executive a project is currently with may add its marketing
   * content (photos, brochure, documents, SEO, description) — and nothing else.
   * Only while it is in their step (PENDING_DM_EXEC) and assigned to them.
   */
  static canPolishContent(
    user: TokenPayload,
    project: { verification_status: string; digital_marketing_executive_id: number | null },
  ): boolean {
    return (
      (user.permissions || []).includes(Permissions.PROJECTS_DM_POLISH) &&
      user.roles.includes(Roles.DIGITAL_MARKETING_EXECUTIVE) &&
      project.verification_status === 'PENDING_DM_EXEC' &&
      project.digital_marketing_executive_id === user.employeeId
    );
  }

  /**
   * Determines whether a user may update a specific Project.
   * - Management: may update any project in their company.
   * - Project Manager: may ONLY update projects explicitly assigned to them.
   * - Telecaller/Agent: NO write access to projects.
   */
  static canUpdate(
    user: TokenPayload,
    project: {
      company_id: number;
      assigned_pm_id: number | null;
      // For the Digital Marketing Executive rule below. Left out => locked.
      verification_status?: string | null;
      created_by_id?: number | null;
      digital_marketing_executive_id?: number | null;
    },
  ): boolean {
    if (!(user.permissions || []).includes(Permissions.PROJECTS_UPDATE)) {
      return false;
    }
    if (!user.roles.includes(Roles.ADMIN) && project.company_id !== user.companyId) {
      return false;
    }
    if (user.roles.includes(Roles.ADMIN)) return true;
    if (this.isManagement(user)) return true;

    // Project Manager: assignment-based
    // Inventory Executive edits every project/property in the company on
    // the PMs' behalf (no delete -- they don't hold the delete permission).
    if (
      user.roles.includes(Roles.INVENTORY_EXECUTIVE) ||
      user.roles.includes(Roles.DATA_ENTRY_OPERATOR)
    )
      return true;

    if (user.roles.includes(Roles.PROJECT_MANAGER)) {
      return this.isOwningPm(user, project);
    }

    // Digital Marketing Executive: a project they added themselves, until the
    // MD approves it (item 3, 2026-11-15). Being assigned a project's
    // marketing step allows its marketing content only (canPolishContent),
    // never its core details or units (owner, 11 Nov). The Head is management.
    if (user.roles.includes(Roles.DIGITAL_MARKETING_EXECUTIVE)) {
      return (
        project.created_by_id === user.employeeId &&
        DM_EXECUTIVE_EDITABLE_PROJECT.includes(project.verification_status ?? '')
      );
    }

    return false;
  }

  /**
   * Only Admin and Technical Manager (whose token carries the Admin role) may
   * delete (cancel) a Project (owner, 2026-11-04). Checked on the role, not only
   * the permission: role permissions are also stored in the database, where the
   * MD and PM rows can still hold it.
   */
  static canDelete(
    user: TokenPayload,
    project: { company_id: number; assigned_pm_id: number | null },
  ): boolean {
    if (!(user.permissions || []).includes(Permissions.PROJECTS_DELETE)) {
      return false;
    }
    return user.roles.includes(Roles.ADMIN);
  }

  /** Replacing a project's PM: MD, Admin and Technical Manager only. */
  static canChangePm(user: TokenPayload): boolean {
    return user.roles.includes(Roles.MD) || user.roles.includes(Roles.ADMIN);
  }
}
