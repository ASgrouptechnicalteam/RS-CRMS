import { TokenPayload } from '../utils/jwt';
import { Roles } from '../shared';
import { Lead } from '@prisma/client';
import { AppError } from '../services/lead.service';

/**
 * Phase 3 - Lead Resource Scope Policy
 * Enforces ownership and cross-company boundaries before mutating data.
 */
export class LeadPolicy {
  /**
   * Identifies if a user holds a management role with global lead access.
   */
  private static isManagement(user: TokenPayload): boolean {
    return user.roles.some((r) =>
      [
        Roles.MD,
        Roles.ADMIN,
        Roles.HR_MANAGER,
        Roles.MARKETING_DIRECTOR,
        Roles.DIGITAL_LEAD_OPERATOR,
        Roles.SALES_MANAGER,
      ].includes(r as any)
    );
  }

  /**
   * Determines if the user is permitted to view the lead.
   * - Must belong to the same company.
   * - Management can view all leads in the company.
   * - Agents/Telecallers can only view leads assigned to them or created by them.
   */
  static canView(user: TokenPayload, lead: Lead): boolean {
    if (lead.company_id !== user.companyId) {
      return false; // Never allow cross-company access
    }

    if (this.isManagement(user)) {
      return true;
    }

    // Telecallers/Agents: Assigned access only
    return (
      lead.assigned_to_id === user.employeeId ||
      lead.created_by_id === user.employeeId
    );
  }

  /**
   * Determines if the user is permitted to mutate (update status/properties) the lead.
   * - Applies the same rules as canView.
   */
  static canMutate(user: TokenPayload, lead: Lead): boolean {
    // Currently, mutation rules are identical to view rules for assigned users.
    // Management can mutate any lead in their company
    if (this.isManagement(user)) {
        return lead.company_id === user.companyId;
    }

    // Telecallers/Agents: can ONLY mutate leads assigned to their own employeeId,
    // OR leads they created that are currently unassigned. Cross-company access is always denied.
    if (
        lead.assigned_to_id === user.employeeId ||
        (lead.assigned_to_id === null && lead.created_by_id === user.employeeId)
    ) {
        return lead.company_id === user.companyId;
    }

    return false;
  }

  /**
   * Determines if the user is permitted to manually reassign a lead to someone else.
   * - Must belong to the same company.
   * - Only Management roles are permitted.
   */
  static canReassign(user: TokenPayload, lead: Lead): boolean {
    if (lead.company_id !== user.companyId) {
      return false;
    }

    return this.isManagement(user);
  }

  /** Returns the list of valid status transitions from the given current status.
   * Lead workflow: NEW -> ASSIGNED -> CONTACTED -> QUALIFIED -> SITE_VISIT_SCHEDULED -> WON
   * Any transition not in this map is illegal.
   */
  static getValidTransitions(status: string): string[] {
    const map: Record<string, string[]> = {
      NEW: ['ASSIGNED'],
      ASSIGNED: ['CONTACTED', 'DROPPED'],
      CONTACTED: ['QUALIFICATION_PENDING', 'QUALIFIED', 'DROPPED'],
      QUALIFICATION_PENDING: ['QUALIFIED', 'DROPPED'],
      QUALIFIED: ['DEMO_SCHEDULED', 'SITE_VISIT_SCHEDULED', 'DROPPED'],
      DEMO_SCHEDULED: ['DEMO_COMPLETED', 'DROPPED'],
      DEMO_COMPLETED: ['SITE_VISIT_SCHEDULED', 'DROPPED'],
      SITE_VISIT_SCHEDULED: ['SITE_VISIT_COMPLETED', 'DROPPED'],
      SITE_VISIT_COMPLETED: ['NEGOTIATION', 'DROPPED'],
      NEGOTIATION: ['BOOKING_INITIATED', 'DROPPED'],
      BOOKING_INITIATED: ['BOOKED', 'DROPPED'],
      BOOKED: [], // terminal won
      DROPPED: ['RECOVERED_TO_POOL'],
      RECOVERED_TO_POOL: ['ASSIGNED'],
    };
    return map[status] || [];
  }

  /** Validates that a status transition is legal according to the lead workflow.
   * Returns the AppError if invalid, or null if valid.
   */
  static validateTransition(currentStatus: string, newStatus: string): { valid: boolean; error?: AppError } {
    if (currentStatus === newStatus) {
      return { valid: true };
    }
    const valid = this.getValidTransitions(currentStatus);
    if (valid.includes(newStatus)) {
      return { valid: true };
    }
    return { valid: false, error: new AppError(409, `Invalid lead status transition: ${currentStatus} → ${newStatus}`) };
  }
}
