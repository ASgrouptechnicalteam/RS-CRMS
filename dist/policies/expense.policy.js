"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExpensePolicy = void 0;
const shared_1 = require("@rrh-ems/shared");
class ExpensePolicy {
    /**
     * Generates a Prisma where clause for listing expenses.
     */
    static getListScope(user, type) {
        if (type === 'MY') {
            return { employee_id: user.employeeId };
        }
        // Queue scope requires strict company isolation
        return { company_id: user.companyId };
    }
    static canCreate(user) {
        return (user.permissions || []).includes(shared_1.Permissions.EXPENSES_CREATE);
    }
    static canReviewAccountant(user, expense) {
        if (!(user.permissions || []).includes(shared_1.Permissions.EXPENSES_REVIEW)) {
            return false;
        }
        if (expense.company_id !== user.companyId) {
            return false;
        }
        if (expense.employee_id === user.employeeId) {
            return false; // Cannot approve own expense
        }
        return true;
    }
    static canReviewMD(user, expense) {
        if (!(user.permissions || []).includes(shared_1.Permissions.EXPENSES_MD_APPROVE)) {
            return false;
        }
        if (expense.company_id !== user.companyId) {
            return false;
        }
        if (expense.employee_id === user.employeeId) {
            return false; // Cannot approve own expense
        }
        return true;
    }
    static canMarkRefunded(user, expense) {
        if (!(user.permissions || []).includes(shared_1.Permissions.EXPENSES_MARK_REFUNDED)) {
            return false;
        }
        if (expense.company_id !== user.companyId) {
            return false;
        }
        if (expense.employee_id === user.employeeId) {
            return false; // Cannot refund own expense
        }
        return true;
    }
}
exports.ExpensePolicy = ExpensePolicy;
