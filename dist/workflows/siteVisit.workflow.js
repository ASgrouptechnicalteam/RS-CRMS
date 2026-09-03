"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SiteVisitWorkflow = void 0;
class SiteVisitWorkflow {
    canTransition(req) {
        const { currentState, action } = req;
        const allowedMap = SiteVisitWorkflow.validTransitions[currentState];
        if (!allowedMap) {
            return {
                allowed: false,
                reason: `Unknown site visit state: ${currentState}`,
            };
        }
        const nextState = allowedMap[action];
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
    static validateTransition(currentStatus, action) {
        const allowedMap = this.validTransitions[currentStatus];
        if (!allowedMap || !allowedMap[action]) {
            throw { status: 409, message: `Invalid workflow transition: Cannot perform ${action} from state ${currentStatus}` };
        }
    }
}
exports.SiteVisitWorkflow = SiteVisitWorkflow;
// Only REAL transitions are listed; any action not present is invalid.
SiteVisitWorkflow.validTransitions = {
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
