"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExpenseRefundService = void 0;
const prisma_1 = require("../lib/prisma");
const shared_1 = require("../shared");
const expenseRefund_policy_1 = require("../policies/expenseRefund.policy");
const expenseRefund_workflow_1 = require("../workflows/expenseRefund.workflow");
const notifyEmployee_1 = require("../utils/notifyEmployee");
const authorization_1 = require("../authz/authorization");
const p = prisma_1.prisma;
class ExpenseRefundService {
    static async listMyRefunds(user) {
        const whereCondition = expenseRefund_policy_1.ExpenseRefundPolicy.canListOwn(user);
        return await p.expenseRefund.findMany({
            where: whereCondition,
            orderBy: { created_at: 'desc' },
        });
    }
    static async listQueue(user) {
        const whereCondition = expenseRefund_policy_1.ExpenseRefundPolicy.canListQueue(user);
        return await p.expenseRefund.findMany({
            where: whereCondition,
            orderBy: { created_at: 'asc' },
            include: {
                employee: { select: { id: true, full_name: true, employee_code: true, department: true } },
            },
        });
    }
    static async createRefund(user, data, file) {
        if (!expenseRefund_policy_1.ExpenseRefundPolicy.canCreate(user)) {
            throw { status: 403, message: 'Forbidden: Missing expenses.create permission' };
        }
        const proofImageUrl = file ? `/uploads/expense-proofs/${file.filename}` : null;
        return await p.$transaction(async (tx) => {
            const refund = await tx.expenseRefund.create({
                data: {
                    employee_id: user.employeeId,
                    company_id: user.companyId,
                    purpose: data.purpose,
                    amount: data.amount,
                    proof_image_url: proofImageUrl,
                    status: shared_1.ExpenseRefundStatus.PENDING,
                },
            });
            await tx.auditEvent.create({
                data: {
                    actor_id: user.employeeId,
                    action: 'EXPENSE_REFUND_SUBMITTED',
                    entity_type: 'EXPENSE_REFUND',
                    entity_id: refund.id,
                    old_value: null,
                    new_value: JSON.stringify({
                        purpose: data.purpose,
                        amount: data.amount,
                        status: shared_1.ExpenseRefundStatus.PENDING,
                    }),
                },
            });
            const accountants = await tx.employee.findMany({
                where: { roles: { some: { role: { name: shared_1.Roles.FINANCE } } }, status: 'ACTIVE', company_id: user.companyId },
                select: { id: true },
            });
            if (accountants.length > 0) {
                await (0, notifyEmployee_1.notifyEmployee)(accountants.map((a) => a.id), {
                    type: 'EXPENSE_REFUND_SUBMITTED',
                    title: '\uD83D\uDCB0 New Expense Refund Request',
                    message: `A new refund of \u20B9${data.amount.toLocaleString('en-IN')} has been submitted for review. Purpose: ${data.purpose}`,
                    link: '/finance',
                });
            }
            return refund;
        });
    }
    static async accountantReview(user, refundId, decision, note) {
        const refund = await p.expenseRefund.findFirst({ where: { id: refundId, company_id: user.companyId } });
        if (!refund)
            throw { status: 404, message: 'Refund request not found' };
        if (!(0, authorization_1.can)(user, shared_1.Permissions.EXPENSES_REVIEW, refund)) {
            throw { status: 403, message: 'Forbidden: Cannot review this refund' };
        }
        const action = decision === 'APPROVE' ? 'ACCOUNTANT_APPROVE' : 'ACCOUNTANT_REJECT';
        const newStatus = decision === 'APPROVE' ? shared_1.ExpenseRefundStatus.ACCOUNTANT_APPROVED : shared_1.ExpenseRefundStatus.REJECTED_BY_ACCOUNTANT;
        expenseRefund_workflow_1.ExpenseRefundWorkflow.validateTransition(refund.status, action);
        return await p.$transaction(async (tx) => {
            const updated = await tx.expenseRefund.update({
                where: { id: refundId },
                data: {
                    status: newStatus,
                    accountant_id: user.employeeId,
                    accountant_note: note || null,
                    accountant_reviewed_at: new Date(),
                },
            });
            const auditAction = decision === 'APPROVE' ? 'EXPENSE_REFUND_ACCOUNTANT_APPROVED' : 'EXPENSE_REFUND_ACCOUNTANT_REJECTED';
            await tx.auditEvent.create({
                data: {
                    actor_id: user.employeeId,
                    action: auditAction,
                    entity_type: 'EXPENSE_REFUND',
                    entity_id: refundId,
                    old_value: JSON.stringify({ status: refund.status }),
                    new_value: JSON.stringify({ status: newStatus, note }),
                },
            });
            if (decision === 'APPROVE') {
                const mds = await tx.employee.findMany({
                    where: { roles: { some: { role: { name: shared_1.Roles.MD } } }, status: 'ACTIVE', company_id: user.companyId },
                    select: { id: true },
                });
                if (mds.length > 0) {
                    await (0, notifyEmployee_1.notifyEmployee)(mds.map((m) => m.id), {
                        type: 'EXPENSE_REFUND_AWAITING_MD',
                        title: '\uD83D\uDCCB Expense Refund Awaits Your Approval',
                        message: `A refund of \u20B9${refund.amount.toLocaleString('en-IN')} has been verified by the accountant and needs your approval.`,
                        link: '/finance',
                    });
                }
            }
            else {
                await (0, notifyEmployee_1.notifyEmployee)(refund.employee_id, {
                    type: 'EXPENSE_REFUND_REJECTED',
                    title: '\u274C Expense Refund Rejected',
                    message: `Your refund request of \u20B9${refund.amount.toLocaleString('en-IN')} was rejected by the accountant.${note ? ` Reason: ${note}` : ''}`,
                    link: '/finance',
                });
            }
            return updated;
        });
    }
    static async mdReview(user, refundId, decision, note) {
        const refund = await p.expenseRefund.findFirst({ where: { id: refundId, company_id: user.companyId } });
        if (!refund)
            throw { status: 404, message: 'Refund request not found' };
        if (!(0, authorization_1.can)(user, shared_1.Permissions.EXPENSES_MD_APPROVE, refund)) {
            throw { status: 403, message: 'Forbidden: Cannot MD review this refund' };
        }
        const action = decision === 'APPROVE' ? 'MD_APPROVE' : 'MD_REJECT';
        const newStatus = decision === 'APPROVE' ? shared_1.ExpenseRefundStatus.MD_APPROVED : shared_1.ExpenseRefundStatus.REJECTED_BY_MD;
        expenseRefund_workflow_1.ExpenseRefundWorkflow.validateTransition(refund.status, action);
        return await p.$transaction(async (tx) => {
            const updated = await tx.expenseRefund.update({
                where: { id: refundId },
                data: {
                    status: newStatus,
                    md_id: user.employeeId,
                    md_note: note || null,
                    md_reviewed_at: new Date(),
                },
            });
            const auditAction = decision === 'APPROVE' ? 'EXPENSE_REFUND_MD_APPROVED' : 'EXPENSE_REFUND_MD_REJECTED';
            await tx.auditEvent.create({
                data: {
                    actor_id: user.employeeId,
                    action: auditAction,
                    entity_type: 'EXPENSE_REFUND',
                    entity_id: refundId,
                    old_value: JSON.stringify({ status: refund.status }),
                    new_value: JSON.stringify({ status: newStatus, note }),
                },
            });
            if (decision === 'APPROVE') {
                await (0, notifyEmployee_1.notifyEmployee)(refund.employee_id, {
                    type: 'EXPENSE_REFUND_MD_APPROVED',
                    title: '\u2705 MD Approved Your Refund!',
                    message: `Your expense refund of \u20B9${refund.amount.toLocaleString('en-IN')} has been approved by the MD. The Finance team will process the payment shortly.`,
                    link: '/finance',
                });
                const accountantsToNotify = [];
                if (refund.accountant_id)
                    accountantsToNotify.push(refund.accountant_id);
                if (accountantsToNotify.length > 0) {
                    await (0, notifyEmployee_1.notifyEmployee)(accountantsToNotify, {
                        type: 'EXPENSE_REFUND_PROCESS_PAYMENT',
                        title: '\uD83D\uDCB3 Please Process Refund Payment',
                        message: `MD has approved a refund of \u20B9${refund.amount.toLocaleString('en-IN')}. Please process the payment and mark it as refunded.`,
                        link: '/finance',
                    });
                }
            }
            else {
                await (0, notifyEmployee_1.notifyEmployee)(refund.employee_id, {
                    type: 'EXPENSE_REFUND_REJECTED',
                    title: '\u274C Expense Refund Rejected by MD',
                    message: `Your refund request of \u20B9${refund.amount.toLocaleString('en-IN')} was not approved.${note ? ` Reason: ${note}` : ''}`,
                    link: '/finance',
                });
            }
            return updated;
        });
    }
    static async markRefunded(user, refundId) {
        const refund = await p.expenseRefund.findFirst({ where: { id: refundId, company_id: user.companyId } });
        if (!refund)
            throw { status: 404, message: 'Refund request not found' };
        if (!(0, authorization_1.can)(user, shared_1.Permissions.EXPENSES_MARK_REFUNDED, refund)) {
            throw { status: 403, message: 'Forbidden: Cannot mark this refund as paid' };
        }
        expenseRefund_workflow_1.ExpenseRefundWorkflow.validateTransition(refund.status, 'MARK_REFUNDED');
        return await p.$transaction(async (tx) => {
            const updated = await tx.expenseRefund.update({
                where: { id: refundId },
                data: {
                    status: shared_1.ExpenseRefundStatus.REFUNDED,
                    refunded_at: new Date(),
                    refunded_by: user.employeeId,
                },
            });
            await tx.auditEvent.create({
                data: {
                    actor_id: user.employeeId,
                    action: 'EXPENSE_REFUND_MARK_REFUNDED',
                    entity_type: 'EXPENSE_REFUND',
                    entity_id: refundId,
                    old_value: JSON.stringify({ status: refund.status }),
                    new_value: JSON.stringify({ status: shared_1.ExpenseRefundStatus.REFUNDED, refunded_by: user.employeeId }),
                },
            });
            await (0, notifyEmployee_1.notifyEmployee)(refund.employee_id, {
                type: 'EXPENSE_REFUNDED',
                title: '\uD83C\uDF89 Your Expense Has Been Refunded!',
                message: `\u20B9${refund.amount.toLocaleString('en-IN')} has been refunded to you. Please collect it from the Finance department.`,
                link: '/finance',
            });
            return updated;
        });
    }
    static async getProof(user, refundId) {
        const refund = await p.expenseRefund.findFirst({ where: { id: refundId, company_id: user.companyId } });
        if (!refund)
            throw { status: 404, message: 'Refund not found' };
        // Use can() fallback for EXPENSES_READ_OWN or just rely on Policy?
        // Actually, can() isn't strictly defined for EXPENSES_READ_OWN on single resource yet.
        // I will leave this one as is or use a base check since the user didn't mention it, but I'll stick to Policy for viewProof.
        if (!expenseRefund_policy_1.ExpenseRefundPolicy.canViewProof(user, refund)) {
            throw { status: 403, message: 'Access denied' };
        }
        if (!refund.proof_image_url) {
            throw { status: 404, message: 'No proof image attached to this request' };
        }
        return refund.proof_image_url;
    }
}
exports.ExpenseRefundService = ExpenseRefundService;
