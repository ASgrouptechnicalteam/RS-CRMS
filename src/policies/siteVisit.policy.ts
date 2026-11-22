import { TokenPayload } from '../utils/jwt';
import { Roles, Permissions } from '../shared';
import { SiteVisitBooking, Lead, Employee } from '@prisma/client';

export class SiteVisitPolicy {
  /** The roles that may manage/override any visit: MD, Admin, and Technical Manager. */
  static isManagement(user: TokenPayload): boolean {
    return user.roles.some((r) =>
      [Roles.MD, Roles.ADMIN, Roles.TECHNICAL_MANAGER].includes(r as any),
    );
  }

  /**
   * Management (Admin, MD, Technical Manager) can cancel a site visit at any time.
   */
  static canCancelAtAnyTime(user: TokenPayload): boolean {
    return this.isManagement(user);
  }

  /**
   * §2 / §8 item #1: "executive department" roles that may see the reassignment
   * `reason`. Narrow set: MD and Admin only (the company has no Marketing
   * Director). Telecallers, PMs, Agents,
   * HR cannot inspect the reasoning behind a reassignment hop — same masking
   * pattern already used for employee PII.
   */
  static canViewReassignmentReason(user: TokenPayload): boolean {
    return user.roles.some((r) => [Roles.MD, Roles.ADMIN].includes(r as any));
  }

  // Who may SEE a visit lives in authz/dataScope.ts (buildSiteVisitScope), like
  // every other domain. Use that to list or look up visits.

  /**
   * Who may re-route or escalate a visit: the PM it is currently routed to, or
   * MD/Admin. Holding site_visits.assign_agent alone is not enough -- that
   * would let any PM take over a colleague's visit.
   */
  static canRouteVisit(user: TokenPayload, visit: { project_manager_id?: number | null }): boolean {
    if (this.isManagement(user)) return true;
    return !!visit.project_manager_id && visit.project_manager_id === user.employeeId;
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

  static canAssignAgent(
    user: TokenPayload,
    visit: { lead: { company_id: number } },
    agent?: Employee,
  ): boolean {
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
    // Fix IDOR: only the person who runs the visit may start/complete it --
    // the agent it was assigned to, or the visit's own PM (who runs it
    // themselves when they don't hand it to an agent). Another PM cannot.
    if (user.roles.includes(Roles.MD) || user.roles.includes(Roles.ADMIN)) {
      return true;
    }
    return (
      visit.assigned_agent_id === user.employeeId || visit.project_manager_id === user.employeeId
    );
  }

  /**
   * Who may choose the agent that runs an accepted visit: the visit's own PM
   * (they accepted it), or MD/Admin. Plain site_visits.assign_agent plus
   * company is checked separately by canAssignAgent.
   */
  static canAssignAgentToVisit(
    user: TokenPayload,
    visit: { project_manager_id?: number | null },
  ): boolean {
    if (user.roles.includes(Roles.MD) || user.roles.includes(Roles.ADMIN)) return true;
    return !!visit.project_manager_id && visit.project_manager_id === user.employeeId;
  }

  /**
   * §2: only the PM/Agent the visit is currently routed to (PENDING_ACCEPTANCE)
   * may accept / reconfirm. For ACCEPTED visits, the assigned PM is the acceptor.
   */
  static canAccept(
    user: TokenPayload,
    visit: { project_manager_id?: number | null; status: string },
  ): boolean {
    if (!(user.permissions || []).includes(Permissions.SITE_VISITS_ACCEPT)) {
      return false;
    }
    if (this.isManagement(user)) return true;

    // The routed PM/Agent is the acceptor.
    return visit.project_manager_id === user.employeeId;
  }

  /**
   * §2 reassignment chain: only PROJECT_MANAGER and AGENT roles may be
   * reassignment targets — never Telecaller, HR, or any other role.
   */
  static canReassignTarget(
    user: TokenPayload,
    target: { roles?: string[]; role?: string; id: number },
  ): boolean {
    const targetRoles: string[] = target.roles ? target.roles : target.role ? [target.role] : [];
    return targetRoles.includes(Roles.PROJECT_MANAGER) || targetRoles.includes(Roles.AGENT);
  }

  /**
   * Who may RUN a visit (assigned_agent_id): a PM, an agent, or an external
   * channel partner (item 5, 2026-11-15). A partner is never a routing target.
   */
  static canRunVisit(target: { roles?: string[] }): boolean {
    const roles = target.roles || [];
    return (
      roles.includes(Roles.PROJECT_MANAGER) ||
      roles.includes(Roles.AGENT) ||
      roles.includes(Roles.CHANNEL_PARTNER_EXTERNAL)
    );
  }

  /**
   * Phase D: Hold and Initiate Cancel are strictly restricted to the assigned telecaller.
   */
  static canHoldOrInitiateCancel(
    user: TokenPayload,
    visit: { telecaller_id?: number | null },
  ): boolean {
    if (!visit.telecaller_id) return false;
    return visit.telecaller_id === user.employeeId;
  }

  /**
   * Phase D: Confirm Cancel is restricted to the assigned project manager (or management override).
   */
  static canConfirmCancel(
    user: TokenPayload,
    visit: { project_manager_id?: number | null },
  ): boolean {
    if (this.isManagement(user)) return true; // Optional management override if desired
    if (!visit.project_manager_id) return false;
    return visit.project_manager_id === user.employeeId;
  }
}
