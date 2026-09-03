"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExpenseRefundPolicy = void 0;
const shared_1 = require("../shared");
class ExpenseRefundPolicy {
    static canCreate(user) {
        return (user.permissions || []).includes(shared_1.Permissions.EXPENSES_CREATE);
    }
    static canListOwn(user) {
        return { employee_id: user.employeeId };
    }
    static canListQueue(user) {
        const hasReview = (user.permissions || []).includes(shared_1.Permissions.EXPENSES_REVIEW);
        const hasMDApprove = (user.permissions || []).includes(shared_1.Permissions.EXPENSES_MD_APPROVE);
        let statusFilter;
        if (hasMDApprove && hasReview) {
            statusFilter = { status: { in: [shared_1.ExpenseRefundStatus.PENDING, shared_1.ExpenseRefundStatus.ACCOUNTANT_APPROVED, shared_1.ExpenseRefundStatus.MD_APPROVED] } };
        }
        else if (hasMDApprove) {
            statusFilter = { status: shared_1.ExpenseRefundStatus.ACCOUNTANT_APPROVED };
        }
        else if (hasReview) {
            statusFilter = { status: { in: [shared_1.ExpenseRefundStatus.PENDING, shared_1.ExpenseRefundStatus.MD_APPROVED] } };
        }
        else {
            statusFilter = { status: 'INVALID_NO_PERMISSION' };
        }
        return {
            AND: [
                { company_id: user.companyId },
                statusFilter,
            ],
        };
    }
    static canAccountantReview(user, refund) {
        if (!(user.permissions || []).includes(shared_1.Permissions.EXPENSES_REVIEW))
            return false;
        if (refund.company_id !== user.companyId)
            return false;
        if (refund.employee_id === user.employeeId)
            return false;
        return refund.status === shared_1.ExpenseRefundStatus.PENDING;
    }
    static canMdReview(user, refund) {
        if (!(user.permissions || []).includes(shared_1.Permissions.EXPENSES_MD_APPROVE))
            return false;
        if (refund.company_id !== user.companyId)
            return false;
        if (refund.employee_id === user.employeeId)
            return false;
        return refund.status === shared_1.ExpenseRefundStatus.ACCOUNTANT_APPROVED;
    }
    static canMarkRefunded(user, refund) {
        if (!(user.permissions || []).includes(shared_1.Permissions.EXPENSES_MARK_REFUNDED))
            return false;
        if (refund.company_id !== user.companyId)
            return false;
        if (refund.employee_id === user.employeeId)
            return false;
        return refund.status === shared_1.ExpenseRefundStatus.MD_APPROVED;
    }
    static canViewProof(user, refund) {
        if (refund.company_id !== user.companyId)
            return false;
        if (refund.employee_id === user.employeeId)
            return true;
        const hasReview = (user.permissions || []).includes(shared_1.Permissions.EXPENSES_REVIEW);
        const hasMDApprove = (user.permissions || []).includes(shared_1.Permissions.EXPENSES_MD_APPROVE);
        const hasMarkRefunded = (user.permissions || []).includes(shared_1.Permissions.EXPENSES_MARK_REFUNDED);
        return hasReview || hasMDApprove || hasMarkRefunded;
    }
}
exports.ExpenseRefundPolicy = ExpenseRefundPolicy;
