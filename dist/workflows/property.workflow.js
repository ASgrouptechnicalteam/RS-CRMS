"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PropertyWorkflow = void 0;
const shared_1 = require("../shared");
class PropertyWorkflow {
    canTransition(req) {
        const { currentState, action } = req;
        const allowedActions = PropertyWorkflow.validTransitions[currentState] || [];
        if (!allowedActions.includes(action)) {
            return {
                allowed: false,
                reason: `Invalid workflow transition: Cannot perform ${action} from state ${currentState}`
            };
        }
        // Determine next state
        let nextState;
        if (action === 'VERIFY')
            nextState = shared_1.PropertyStatus.PENDING_DM_POLISH;
        else if (action === 'DM_POLISH')
            nextState = shared_1.PropertyStatus.PENDING_MD_APPROVAL;
        else if (action === 'DM_VERIFY_AS_IS')
            nextState = shared_1.PropertyStatus.PENDING_MD_APPROVAL;
        else if (action === 'MD_APPROVE')
            nextState = shared_1.PropertyStatus.LIVE; // Or REJECTED, handled dynamically by service based on 'approved' flag
        return { allowed: true, nextState };
    }
    /**
     * Validates if a transition is allowed.
     * Throws an error (handled as 409 in service) if the transition is invalid.
     */
    static validateTransition(currentStatus, action) {
        const allowedActions = this.validTransitions[currentStatus] || [];
        if (!allowedActions.includes(action)) {
            throw new Error(`Invalid workflow transition: Cannot perform ${action} from state ${currentStatus}`);
        }
    }
}
exports.PropertyWorkflow = PropertyWorkflow;
PropertyWorkflow.validTransitions = {
    [shared_1.PropertyStatus.PENDING_VERIFICATION]: ['VERIFY'],
    // DMH can either send to a DM Executive for polish, or verify as-is and skip straight to MD approval
    [shared_1.PropertyStatus.PENDING_DM_POLISH]: ['DM_POLISH', 'DM_VERIFY_AS_IS'],
    [shared_1.PropertyStatus.PENDING_MD_APPROVAL]: ['MD_APPROVE'],
};
