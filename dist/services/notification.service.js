"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NotificationService = exports.CUSTOMER_NOTIFICATION_LIMIT = exports.AppError = void 0;
const prisma_1 = require("../lib/prisma");
const p = prisma_1.prisma;
class AppError extends Error {
    statusCode;
    constructor(statusCode, message) {
        super(message);
        this.statusCode = statusCode;
        this.name = 'AppError';
    }
}
exports.AppError = AppError;
exports.CUSTOMER_NOTIFICATION_LIMIT = 100;
/**
 * Phase 11 Packet 3E - Customer Notifications.
 *
 * - Customer notification records are company-scoped AND customer-scoped.
 * - Only the internal `createCustomerNotificationTx` helper creates rows, always
 *   inside the same transaction as the domain transition that triggered it.
 * - Content is LOW sensitivity only (type/title/message). Raw PAN/Aadhaar, bank
 *   details and salary must NEVER be passed here.
 * - The Portal-facing read API is strictly READ-ONLY; there is no mutation endpoint.
 */
class NotificationService {
    /**
     * Creates a customer notification inside an existing transaction (Packet 3E).
     * Enforces tenant ownership: the customer must belong to company_id, otherwise
     * an AppError is thrown and the enclosing transaction rolls back.
     */
    static async createCustomerNotificationTx(tx, dto) {
        const customer = await tx.customer.findFirst({
            where: { id: dto.customer_id, company_id: dto.company_id },
            select: { id: true },
        });
        if (!customer) {
            throw new AppError(404, 'Customer not found or access denied');
        }
        return tx.customerNotification.create({
            data: {
                company_id: dto.company_id,
                customer_id: dto.customer_id,
                booking_id: dto.booking_id ?? null,
                type: dto.type,
                title: dto.title,
                message: dto.message,
            },
        });
    }
    /**
     * Read-only Portal-facing list of a customer's notifications (Packet 3E).
     * Tenant + customer scoped; deterministic ordering (created_at DESC, id DESC
     * tiebreak); returns only LOW-sensitivity fields + pagination metadata.
     */
    static async listForPortal(dto) {
        const { company_id, crms_customer_id, page, limit } = dto;
        const customer = await p.customer.findFirst({
            where: { id: crms_customer_id, company_id },
            select: { id: true },
        });
        if (!customer) {
            throw new AppError(404, 'Customer not found');
        }
        const where = { company_id, customer_id: crms_customer_id };
        const [total, rows] = await Promise.all([
            p.customerNotification.count({ where }),
            p.customerNotification.findMany({
                where,
                orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
                skip: (page - 1) * limit,
                take: limit,
            }),
        ]);
        return {
            notifications: rows.map((n) => ({
                id: n.id,
                type: n.type,
                title: n.title,
                message: n.message,
                is_read: n.is_read,
                booking_id: n.booking_id,
                created_at: n.created_at.toISOString(),
            })),
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
            },
        };
    }
}
exports.NotificationService = NotificationService;
