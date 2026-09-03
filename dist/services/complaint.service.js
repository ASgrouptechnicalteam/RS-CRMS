"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ComplaintService = void 0;
// Complaint Management Service (Phase 14 - Packet 14-1)
// Authorized scope: Complaint Management only (backend).
// Reuses existing repository architecture: AppError, PrismaClient, AuditEvent,
// centralized lifecycle transition map, company isolation on every query.
const prisma_1 = require("../lib/prisma");
const lead_service_1 = require("./lead.service");
const crypto_1 = __importDefault(require("crypto"));
const p = prisma_1.prisma;
// ---- Authorized constants (Packet 14-1) ----
const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH'];
const CLOSURE_REASONS = ['RESOLVED', 'CUSTOMER_UNSATISFIED', 'NOT_APPLICABLE', 'CUSTOMER_WITHDRAWN'];
// ---- Single centralized lifecycle transition map (no SLA / no auto-transitions) ----
const TRANSITIONS = {
    OPEN: ['IN_PROGRESS', 'RESOLVED'],
    IN_PROGRESS: ['RESOLVED'],
    RESOLVED: ['CLOSED'],
    CLOSED: ['REOPENED'],
    REOPENED: ['IN_PROGRESS', 'RESOLVED'],
};
class ComplaintService {
    /**
     * Repository-safe identifier generation: RRH-CMP-<YYYY>-<seq>-<4hex>
     * - sequence is company-scoped count (padded)
     * - 4-char random hex removes reliance on timestamps
     * - P2002 unique-constraint collisions are retried by create()
     */
    static async generateComplaintCode(tx, companyId) {
        const year = new Date().getFullYear();
        const count = await tx.complaint.count({ where: { company_id: companyId } });
        const hex = crypto_1.default.randomBytes(2).toString('hex').toUpperCase();
        return `RRH-CMP-${year}-${String(count + 1).padStart(4, '0')}-${hex}`;
    }
    static async audit(tx, user, action, entityId, oldValue, newValue) {
        await tx.auditEvent.create({
            data: {
                actor_id: user.employeeId,
                action,
                entity_type: 'Complaint',
                entity_id: entityId,
                old_value: oldValue,
                new_value: newValue,
                created_at: new Date(),
            },
        });
    }
    /** Company-scoped fetch; rejects cross-company access with 404 to avoid information disclosure. */
    static async scopedGet(user, id) {
        const c = await prisma_1.prisma.complaint.findFirst({
            where: { id, company_id: user.companyId },
            include: { customer: true, booking: true, property: true, assigned_employee: true },
        });
        if (!c) {
            throw new lead_service_1.AppError(404, 'Complaint not found');
        }
        return c;
    }
    // ------------------------------------------------------------------ create
    static async create(user, data) {
        // Company ownership validation for every linked entity
        const customer = await prisma_1.prisma.customer.findFirst({ where: { id: data.customer_id, company_id: user.companyId } });
        if (!customer) {
            throw new lead_service_1.AppError(403, 'Customer not found or cross-company access');
        }
        if (data.booking_id) {
            const b = await prisma_1.prisma.booking.findFirst({ where: { id: data.booking_id, company_id: user.companyId } });
            if (!b) {
                throw new lead_service_1.AppError(403, 'Booking not found or cross-company access');
            }
        }
        if (data.property_id) {
            const prop = await prisma_1.prisma.property.findFirst({ where: { id: data.property_id, company_id: user.companyId } });
            if (!prop) {
                throw new lead_service_1.AppError(403, 'Property not found or cross-company access');
            }
        }
        if (data.assigned_employee_id) {
            const emp = await prisma_1.prisma.employee.findFirst({ where: { id: data.assigned_employee_id, company_id: user.companyId } });
            if (!emp) {
                throw new lead_service_1.AppError(403, 'Employee not found or cross-company assignment');
            }
        }
        const priority = data.priority || 'MEDIUM';
        if (!PRIORITIES.includes(priority)) {
            throw new lead_service_1.AppError(400, 'Invalid priority');
        }
        // Bounded P2002 retry for complaint_code uniqueness
        for (let attempt = 0; attempt < 5; attempt++) {
            try {
                return await prisma_1.prisma.$transaction(async (tx) => {
                    const code = await ComplaintService.generateComplaintCode(tx, user.companyId);
                    const complaint = await tx.complaint.create({
                        data: {
                            complaint_code: code,
                            company_id: user.companyId,
                            customer_id: data.customer_id,
                            title: data.title,
                            category: data.category ?? null,
                            description: data.description ?? null,
                            priority,
                            status: 'OPEN',
                            booking_id: data.booking_id ?? null,
                            property_id: data.property_id ?? null,
                            assigned_employee_id: data.assigned_employee_id ?? null,
                        },
                    });
                    await ComplaintService.audit(tx, user, 'created', complaint.id, null, complaint.complaint_code);
                    return complaint;
                });
            }
            catch (err) {
                if (err?.code === 'P2002')
                    continue; // retry with a fresh code
                throw err;
            }
        }
        throw new lead_service_1.AppError(409, 'Could not generate a unique complaint code');
    }
    // ------------------------------------------------------------------- list
    static async list(user, options) {
        // Hard company scope on every list query
        const where = { company_id: user.companyId };
        if (options?.status)
            where.status = options.status;
        if (options?.priority)
            where.priority = options.priority;
        if (options?.category)
            where.category = options.category;
        if (options?.customer_id) {
            const c = await prisma_1.prisma.customer.findFirst({ where: { id: options.customer_id, company_id: user.companyId } });
            if (!c) {
                throw new lead_service_1.AppError(403, 'Cross-company customer filter');
            }
            where.customer_id = options.customer_id;
        }
        return prisma_1.prisma.complaint.findMany({
            where,
            include: { customer: true, booking: true, property: true, assigned_employee: true },
            orderBy: { created_at: 'desc' },
        });
    }
    // ---------------------------------------------------------------- getById
    static async getById(user, id) {
        return ComplaintService.scopedGet(user, id);
    }
    // ----------------------------------------------------------------- update
    static async update(user, id, data) {
        await ComplaintService.scopedGet(user, id);
        const next = {};
        if (data.title !== undefined)
            next.title = data.title;
        if (data.description !== undefined)
            next.description = data.description ?? null;
        if (data.category !== undefined)
            next.category = data.category ?? null;
        if (data.priority !== undefined) {
            if (data.priority !== null && !PRIORITIES.includes(data.priority)) {
                throw new lead_service_1.AppError(400, 'Invalid priority');
            }
            next.priority = data.priority;
        }
        return prisma_1.prisma.complaint.update({ where: { id }, data: next });
    }
    // ----------------------------------------------------------------- assign
    static async assign(user, id, employeeId) {
        const c = await ComplaintService.scopedGet(user, id);
        const emp = await prisma_1.prisma.employee.findFirst({ where: { id: employeeId, company_id: user.companyId } });
        if (!emp) {
            throw new lead_service_1.AppError(403, 'Employee not found or cross-company assignment');
        }
        if (!['OPEN', 'IN_PROGRESS', 'REOPENED'].includes(c.status)) {
            throw new lead_service_1.AppError(400, `Cannot assign complaint in ${c.status} status`);
        }
        return prisma_1.prisma.$transaction(async (tx) => {
            const updated = await tx.complaint.update({ where: { id }, data: { assigned_employee_id: employeeId } });
            await ComplaintService.audit(tx, user, 'assigned', id, c.assigned_employee_id?.toString() ?? null, String(employeeId));
            return updated;
        });
    }
    // ------------------------------------------------------------ changeStatus
    static async changeStatus(user, id, status) {
        const c = await ComplaintService.scopedGet(user, id);
        const allowed = TRANSITIONS[c.status] || [];
        if (!allowed.includes(status)) {
            throw new lead_service_1.AppError(400, `Invalid transition from ${c.status} to ${status}`);
        }
        const action = c.status === 'CLOSED' && status === 'REOPENED' ? 'reopened' : 'status_changed';
        return prisma_1.prisma.$transaction(async (tx) => {
            const updated = await tx.complaint.update({ where: { id }, data: { status } });
            await ComplaintService.audit(tx, user, action, id, c.status, status);
            return updated;
        });
    }
    // ---------------------------------------------------------------- resolve
    static async resolve(user, id, resolutionDescription) {
        const c = await ComplaintService.scopedGet(user, id);
        if (!['OPEN', 'IN_PROGRESS', 'REOPENED'].includes(c.status)) {
            throw new lead_service_1.AppError(400, `Cannot resolve complaint in ${c.status} status`);
        }
        // resolved_by is the acting authenticated employee (inherently same company)
        return prisma_1.prisma.$transaction(async (tx) => {
            const updated = await tx.complaint.update({
                where: { id },
                data: { status: 'RESOLVED', resolution_description: resolutionDescription, resolved_by: user.employeeId, resolved_at: new Date() },
            });
            await ComplaintService.audit(tx, user, 'resolved', id, c.status, 'RESOLVED');
            return updated;
        });
    }
    // ------------------------------------------------------------------ close
    static async close(user, id, closureReason) {
        const c = await ComplaintService.scopedGet(user, id);
        if (c.status !== 'RESOLVED') {
            throw new lead_service_1.AppError(400, 'Cannot close complaint that is not RESOLVED');
        }
        if (closureReason && !CLOSURE_REASONS.includes(closureReason)) {
            throw new lead_service_1.AppError(400, 'Invalid closure_reason');
        }
        const reason = closureReason || 'RESOLVED';
        return prisma_1.prisma.$transaction(async (tx) => {
            const updated = await tx.complaint.update({
                where: { id },
                data: { status: 'CLOSED', closed_at: new Date(), closure_reason: reason },
            });
            await ComplaintService.audit(tx, user, 'closed', id, c.status, 'CLOSED');
            return updated;
        });
    }
}
exports.ComplaintService = ComplaintService;
exports.default = ComplaintService;
