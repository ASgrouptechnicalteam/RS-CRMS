import { DomainWorkflow, WorkflowTransitionRequest, WorkflowTransitionResult } from './types';

/**
 * §2 Site Visit Sub-Workflow (nested under Lead.status = SITE_VISIT_SCHEDULED).
 *
 * State machine (docs/LEAD-WORKFLOW-SPEC.md §2):
 *   REQUESTED
 *     → ROUTE            (auto → PENDING_ACCEPTANCE, routed to project's PM)
 *     → PENDING_ACCEPTANCE
 *       → ACCEPT         (PM/Agent accepts)        → ACCEPTED
 *       → REASSIGN       (open chain, logged)      → REASSIGNED (then re-routed to PENDING_ACCEPTANCE)
 *       → ESCALATE       (no PM/Agent left)        → ESCALATED_TO_MARKETING_DIRECTOR
 *     → ACCEPTED
 *       → RECONFIRM_CUSTOMER (day-before call)     → PENDING_CUSTOMER_RECONFIRMATION
 *     → PENDING_CUSTOMER_RECONFIRMATION
 *       → RESCHEDULE     (customer wants change)   → RESCHEDULE_REQUESTED
 *       → CONFIRM                                   → CONFIRMED
 *     → RESCHEDULE_REQUESTED
 *       → PM_CONFIRM     (confirm new date/property) → PENDING_PM_RECONFIRMATION
 *     → PENDING_PM_RECONFIRMATION
 *       → PM_CONFIRM     (X confirms)              → ACCEPTED
 *       → PM_RELEASE     (X releases)              → PENDING_ACCEPTANCE (reset to authoritative PM)
 *     → CONFIRMED
 *       → START          (day-of)                  → ACTIVE
 *     → ACTIVE
 *       → COMPLETE                                  → COMPLETED
 *     → COMPLETED (terminal)
 *     → CANCELLED (terminal)
 *   Any non-terminal state may → CANCEL.
 */
export type SiteVisitAction =
  | 'ROUTE'
  | 'ACCEPT'
  | 'REASSIGN'
  | 'ESCALATE'
  | 'RECONFIRM_CUSTOMER'
  | 'RESCHEDULE'
  | 'PM_CONFIRM'
  | 'PM_RELEASE'
  | 'CONFIRM'
  | 'START'
  | 'COMPLETE'
  | 'CANCEL';

export class SiteVisitWorkflow implements DomainWorkflow {
  // Only REAL transitions are listed; any action not present is invalid.
  private static readonly validTransitions: Partial<Record<string, Partial<Record<SiteVisitAction, string>>>> = {
    REQUESTED: {
      ROUTE: 'PENDING_ACCEPTANCE',
      CANCEL: 'CANCELLED',
    },
    PENDING_ACCEPTANCE: {
      ACCEPT: 'ACCEPTED',
      REASSIGN: 'REASSIGNED',
      ESCALATE: 'ESCALATED_TO_MARKETING_DIRECTOR',
      CANCEL: 'CANCELLED',
    },
    REASSIGNED: {
      ROUTE: 'PENDING_ACCEPTANCE',
      CANCEL: 'CANCELLED',
    },
    ESCALATED_TO_MARKETING_DIRECTOR: {
      ROUTE: 'PENDING_ACCEPTANCE',
      CANCEL: 'CANCELLED',
    },
    ACCEPTED: {
      RECONFIRM_CUSTOMER: 'PENDING_CUSTOMER_RECONFIRMATION',
      CANCEL: 'CANCELLED',
    },
    PENDING_CUSTOMER_RECONFIRMATION: {
      RESCHEDULE: 'RESCHEDULE_REQUESTED',
      CONFIRM: 'CONFIRMED',
      CANCEL: 'CANCELLED',
    },
    RESCHEDULE_REQUESTED: {
      PM_CONFIRM: 'PENDING_PM_RECONFIRMATION',
      CANCEL: 'CANCELLED',
    },
    PENDING_PM_RECONFIRMATION: {
      PM_CONFIRM: 'ACCEPTED',
      PM_RELEASE: 'PENDING_ACCEPTANCE',
      CANCEL: 'CANCELLED',
    },
    CONFIRMED: {
      START: 'ACTIVE',
      CANCEL: 'CANCELLED',
    },
    ACTIVE: {
      COMPLETE: 'COMPLETED',
      CANCEL: 'CANCELLED',
    },
    COMPLETED: {},
    CANCELLED: {},
  };

  canTransition(req: WorkflowTransitionRequest): WorkflowTransitionResult {
    const { currentState, action } = req;
    const allowedMap = SiteVisitWorkflow.validTransitions[currentState];

    if (!allowedMap) {
      return {
        allowed: false,
        reason: `Unknown site visit state: ${currentState}`,
      };
    }

    const nextState = allowedMap[action as SiteVisitAction];
    if (!nextState) {
      return {
        allowed: false,
        reason: `Invalid site visit transition: cannot perform ${action} from ${currentState}`,
      };
    }

    return { allowed: true, nextState };
  }

  /**
   * Validates if a transition is allowed. Throws an error (handled as 409 in
   * service) if the transition is invalid. Kept for backward compatibility.
   */
  static validateTransition(currentStatus: string, action: SiteVisitAction): void {
    const allowedMap = this.validTransitions[currentStatus];
    if (!allowedMap || !allowedMap[action]) {
      throw { status: 409, message: `Invalid workflow transition: Cannot perform ${action} from state ${currentStatus}` };
    }
  }
}
