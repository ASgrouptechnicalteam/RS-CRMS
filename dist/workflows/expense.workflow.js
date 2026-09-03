"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExpenseWorkflow = void 0;
class ExpenseWorkflow {
    /**
     * Validates if a transition is allowed.
     * Throws an error (handled as 409 in service) if the transition is invalid.
     */
    static validateTransition(currentStatus, action) {
        const validTransitions = {
            'PENDING': ['ACCOUNTANT_APPROVE', 'ACCOUNTANT_REJECT'],
            'ACCOUNTANT_APPROVED': ['MD_APPROVE', 'MD_REJECT'],
            'MD_APPROVED': ['REFUND'],
            // REJECTED_BY_ACCOUNTANT, REJECTED_BY_MD, REFUNDED are terminal states
        };
        const allowedActions = validTransitions[currentStatus] || [];
        if (!allowedActions.includes(action)) {
            throw { status: 409, message: `Invalid workflow transition: Cannot perform ${action} from state ${currentStatus}` };
        }
    }
}
exports.ExpenseWorkflow = ExpenseWorkflow;
