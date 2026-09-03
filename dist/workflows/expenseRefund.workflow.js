"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExpenseRefundWorkflow = void 0;
const shared_1 = require("../shared");
class ExpenseRefundWorkflow {
    static validateTransition(currentStatus, action) {
        const validTransitions = {
            [shared_1.ExpenseRefundStatus.PENDING]: ['ACCOUNTANT_APPROVE', 'ACCOUNTANT_REJECT'],
            [shared_1.ExpenseRefundStatus.ACCOUNTANT_APPROVED]: ['MD_APPROVE', 'MD_REJECT'],
            [shared_1.ExpenseRefundStatus.MD_APPROVED]: ['MARK_REFUNDED'],
        };
        const allowedActions = validTransitions[currentStatus] || [];
        if (!allowedActions.includes(action)) {
            throw { status: 409, message: `Invalid workflow transition: Cannot perform ${action} from state ${currentStatus}` };
        }
    }
}
exports.ExpenseRefundWorkflow = ExpenseRefundWorkflow;
