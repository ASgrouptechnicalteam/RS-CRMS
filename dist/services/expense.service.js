"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExpenseService = void 0;
const client_1 = require("@prisma/client");
const shared_1 = require("@rrh-ems/shared");
const expense_policy_1 = require("../policies/expense.policy");
const expense_workflow_1 = require("../workflows/expense.workflow");
const notifyEmployee_1 = require("../utils/notifyEmployee");
const prisma = new client_1.PrismaClient();
const p = prisma;
class ExpenseService {
    static async listMyExpenses(user) {
        const scope = expense_policy_1.ExpensePolicy.getListScope(user, 'MY');
        return await p.expenseRefund.findMany({
            where: scope,
            orderBy: { created_at: 'desc' },
        });
    }
    static async listQueueExpenses(user) {
        const scope = expense_policy_1.ExpensePolicy.getListScope(user, 'QUEUE');
        const isMD = user.roles.includes(shared_1.Roles.MD);
        // MD sees ACCOUNTANT_APPROVED items; Accountant sees PENDING and MD_APPROVED
        const statusFilter = isMD
            ? { status: 'ACCOUNTANT_APPROVED' }
            : { status: { in: ['PENDING', 'MD_APPROVED'] } };
        return await p.expenseRefund.findMany({
            where: {
                AND: [scope, statusFilter]
            },
            orderBy: { created_at: 'asc' },
            include: {
                employee: {
                    select: { id: true, full_name: true, employee_code: true, department: true },
                },
            },
        });
    }
    static async submitExpense(user, data) {
        if (!expense_policy_1.ExpensePolicy.canCreate(user)) {
            throw { status: 403, message: 'Forbidden: Missing expenses.create permission' };
        }
        const { purpose, amount, proof_image_url } = data;
        return await p.$transaction(async (tx) => {
            const refund = await tx.expenseRefund.create({
                data: {
                    employee_id: user.employeeId,
                    company_id: user.companyId,
                    purpose,
                    amount,
                    proof_image_url,
                    status: 'PENDING',
                },
            });
            await tx.auditEvent.create({
                data: {
                    actor_id: user.employeeId,
                    action: 'EXPENSE_SUBMITTED',
                    entity_type: 'ExpenseRefund',
                    entity_id: refund.id,
                    new_value: 'PENDING'
                }
            });
            const accountants = await tx.employee.findMany({
                where: {
                    company_id: user.companyId,
                    status: 'ACTIVE',
                    roles: { some: { role: { name: shared_1.Roles.FINANCE } } },
                },
                select: { id: true },
            });
            const accountantIds = accountants.map((a) => a.id);
            if (accountantIds.length > 0) {
                await (0, notifyEmployee_1.notifyEmployee)(accountantIds, {
                    type: 'EXPENSE_REFUND_SUBMITTED',
                    title: '💰 New Expense Refund Request',
                    message: `A new refund of ₹${amount.toLocaleString('en-IN')} has been submitted for review. Purpose: ${purpose}`,
                    link: '/finance',
                });
            }
            return refund;
        });
    }
    static async reviewAccountant(user, expenseId, decision, note) {
        const refund = await p.expenseRefund.findUnique({ where: { id: expenseId } });
        if (!refund)
            throw { status: 404, message: 'Refund request not found.' };
        if (!expense_policy_1.ExpensePolicy.canReviewAccountant(user, refund)) {
            throw { status: 403, message: 'Forbidden: Missing expenses.review permission or cross-company/self-approval attempt' };
        }
        const action = decision === 'APPROVE' ? 'ACCOUNTANT_APPROVE' : 'ACCOUNTANT_REJECT';
        expense_workflow_1.ExpenseWorkflow.validateTransition(refund.status, action);
        const newStatus = decision === 'APPROVE' ? 'ACCOUNTANT_APPROVED' : 'REJECTED_BY_ACCOUNTANT';
        return await p.$transaction(async (tx) => {
            const updated = await tx.expenseRefund.update({
                where: { id: expenseId },
                data: {
                    status: newStatus,
                    accountant_id: user.employeeId,
                    accountant_note: note || null,
                    accountant_reviewed_at: new Date(),
                },
            });
            await tx.auditEvent.create({
                data: {
                    actor_id: user.employeeId,
                    action: action,
                    entity_type: 'ExpenseRefund',
                    entity_id: refund.id,
                    old_value: refund.status,
                    new_value: newStatus
                }
            });
            if (decision === 'APPROVE') {
                const mds = await tx.employee.findMany({
                    where: { company_id: user.companyId, roles: { some: { role: { name: shared_1.Roles.MD } } }, status: 'ACTIVE' },
                    select: { id: true },
                });
                if (mds.length > 0) {
                    await (0, notifyEmployee_1.notifyEmployee)(mds.map((m) => m.id), {
                        type: 'EXPENSE_REFUND_AWAITING_MD',
                        title: '📋 Expense Refund Awaits Your Approval',
                        message: `A refund of ₹${refund.amount.toLocaleString('en-IN')} has been verified by the accountant and needs your approval.`,
                        link: '/finance',
                    });
                }
            }
            else {
                await (0, notifyEmployee_1.notifyEmployee)(refund.employee_id, {
                    type: 'EXPENSE_REFUND_REJECTED',
                    title: '❌ Expense Refund Rejected',
                    message: `Your refund request of ₹${refund.amount.toLocaleString('en-IN')} was rejected by the accountant.${note ? ` Reason: ${note}` : ''}`,
                    link: '/finance',
                });
            }
            return updated;
        });
    }
    static async reviewMD(user, expenseId, decision, note) {
        const refund = await p.expenseRefund.findUnique({ where: { id: expenseId } });
        if (!refund)
            throw { status: 404, message: 'Refund request not found.' };
        if (!expense_policy_1.ExpensePolicy.canReviewMD(user, refund)) {
            throw { status: 403, message: 'Forbidden: Missing expenses.md_approve permission or cross-company/self-approval attempt' };
        }
        const action = decision === 'APPROVE' ? 'MD_APPROVE' : 'MD_REJECT';
        expense_workflow_1.ExpenseWorkflow.validateTransition(refund.status, action);
        const newStatus = decision === 'APPROVE' ? 'MD_APPROVED' : 'REJECTED_BY_MD';
        return await p.$transaction(async (tx) => {
            const updated = await tx.expenseRefund.update({
                where: { id: expenseId },
                data: {
                    status: newStatus,
                    md_id: user.employeeId,
                    md_note: note || null,
                    md_reviewed_at: new Date(),
                },
            });
            await tx.auditEvent.create({
                data: {
                    actor_id: user.employeeId,
                    action: action,
                    entity_type: 'ExpenseRefund',
                    entity_id: refund.id,
                    old_value: refund.status,
                    new_value: newStatus
                }
            });
            if (decision === 'APPROVE') {
                const accountantsToNotify = [];
                if (refund.accountant_id)
                    accountantsToNotify.push(refund.accountant_id);
                await (0, notifyEmployee_1.notifyEmployee)(refund.employee_id, {
                    type: 'EXPENSE_REFUND_MD_APPROVED',
                    title: '✅ MD Approved Your Refund!',
                    message: `Your expense refund of ₹${refund.amount.toLocaleString('en-IN')} has been approved by the MD. The Finance team will process the payment shortly.`,
                    link: '/finance',
                });
                if (accountantsToNotify.length > 0) {
                    await (0, notifyEmployee_1.notifyEmployee)(accountantsToNotify, {
                        type: 'EXPENSE_REFUND_PROCESS_PAYMENT',
                        title: '💳 Please Process Refund Payment',
                        message: `MD has approved a refund of ₹${refund.amount.toLocaleString('en-IN')}. Please process the payment and mark it as refunded.`,
                        link: '/finance',
                    });
                }
            }
            else {
                await (0, notifyEmployee_1.notifyEmployee)(refund.employee_id, {
                    type: 'EXPENSE_REFUND_REJECTED',
                    title: '❌ Expense Refund Rejected by MD',
                    message: `Your refund request of ₹${refund.amount.toLocaleString('en-IN')} was not approved.${note ? ` Reason: ${note}` : ''}`,
                    link: '/finance',
                });
            }
            return updated;
        });
    }
    static async markRefunded(user, expenseId) {
        const refund = await p.expenseRefund.findUnique({ where: { id: expenseId } });
        if (!refund)
            throw { status: 404, message: 'Refund request not found.' };
        if (!expense_policy_1.ExpensePolicy.canMarkRefunded(user, refund)) {
            throw { status: 403, message: 'Forbidden: Missing expenses.mark_refunded permission or cross-company/self-refund attempt' };
        }
        expense_workflow_1.ExpenseWorkflow.validateTransition(refund.status, 'REFUND');
        return await p.$transaction(async (tx) => {
            const updated = await tx.expenseRefund.update({
                where: { id: expenseId },
                data: {
                    status: 'REFUNDED',
                    refunded_at: new Date(),
                    refunded_by: user.employeeId,
                },
            });
            await tx.auditEvent.create({
                data: {
                    actor_id: user.employeeId,
                    action: 'REFUND',
                    entity_type: 'ExpenseRefund',
                    entity_id: refund.id,
                    old_value: refund.status,
                    new_value: 'REFUNDED'
                }
            });
            await (0, notifyEmployee_1.notifyEmployee)(refund.employee_id, {
                type: 'EXPENSE_REFUNDED',
                title: '🎉 Your Expense Has Been Refunded!',
                message: `₹${refund.amount.toLocaleString('en-IN')} has been refunded to you. Please collect it from the Finance department.`,
                link: '/finance',
            });
            return updated;
        });
    }
}
exports.ExpenseService = ExpenseService;
