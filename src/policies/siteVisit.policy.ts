import { TokenPayload } from '../utils/jwt';
import { Roles, Permissions } from '../shared';
import { SiteVisitBooking, Lead, Employee } from '@prisma/client';

export class SiteVisitPolicy {
  private static isManagement(user: TokenPayload): boolean {
    return user.roles.some((r) =>
      [
        Roles.MD,
        Roles.ADMIN,
        Roles.HR_MANAGER,
        Roles.MARKETING_DIRECTOR,
        Roles.PROJECT_MANAGER,
      ].includes(r as any)
    );
  }

  /**
   * §2 / §8 item #1: "executive department" roles that may see the reassignment
   * `reason`. Confirmed narrow set: MD, Admin, Marketing Director only
   * (per spec §8 assumption, now ratified by user). Telecallers, PMs, Agents,
   * HR cannot inspect the reasoning behind a reassignment hop — same masking
   * pattern already used for employee PII.
   */
  static canViewReassignmentReason(user: TokenPayload): boolean {
    return user.roles.some((r) =>
      [Roles.MD, Roles.ADMIN, Roles.MARKETING_DIRECTOR].includes(r as any),
    );
  }

  static canList(user: TokenPayload): any {
    const isManagement = this.isManagement(user);
    
    // Unconditional tenant isolation via explicit AND
    const whereCondition: any = {
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

  static canCreate(user: TokenPayload, lead: { company_id: number }): boolean {
    if (!(user.permissions || []).includes(Permissions.SITE_VISITS_CREATE)) {
      return false;
    }
    return lead.company_id === user.companyId;
  }

  static canVerify(user: TokenPayload, visit: { lead: { company_id: number } }): boolean {
    if (!(user.permissions || []).includes(Permissions.SITE_VISITS_VERIFY)) {
      return false;
    }
    return visit.lead.company_id === user.companyId;
  }

  static canAssignAgent(user: TokenPayload, visit: { lead: { company_id: number } }, agent?: Employee): boolean {
    if (!(user.permissions || []).includes(Permissions.SITE_VISITS_ASSIGN_AGENT)) {
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

  static canComplete(user: TokenPayload, visit: any): boolean {
    if (!(user.permissions || []).includes(Permissions.SITE_VISITS_COMPLETE)) {
      return false;
    }
    if (visit.lead.company_id !== user.companyId) {
      return false;
    }
    // Fix IDOR: ensure the completing agent is the assigned agent, unless they are admin/management
    if (user.roles.includes(Roles.MD) || user.roles.includes(Roles.ADMIN)) {
      return true;
    }
    return visit.assigned_agent_id === user.employeeId;
  }

  /**
   * §2: only the PM/Agent the visit is currently routed to (PENDING_ACCEPTANCE)
   * may accept / reconfirm. For ACCEPTED visits, the assigned PM is the acceptor.
   */
  static canAccept(user: TokenPayload, visit: { project_manager_id?: number | null; status: string }): boolean {
    if (!(user.permissions || []).includes(Permissions.SITE_VISITS_ASSIGN_AGENT)) {
      return false;
    }
    // The routed PM/Agent is the acceptor.
    return visit.project_manager_id === user.employeeId;
  }

  /**
   * §2 reassignment chain: only PROJECT_MANAGER and AGENT roles may be
   * reassignment targets — never Telecaller, HR, or any other role.
   */
  static canReassignTarget(user: TokenPayload, target: { roles?: string[]; role?: string; id: number }): boolean {
    const targetRoles: string[] = target.roles
      ? target.roles
      : target.role
      ? [target.role]
      : [];
    return targetRoles.includes(Roles.PROJECT_MANAGER) || targetRoles.includes(Roles.AGENT);
  }
}
