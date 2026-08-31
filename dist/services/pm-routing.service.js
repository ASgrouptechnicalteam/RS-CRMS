"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PMRoutingService = exports.AppError = void 0;
const prisma_1 = require("../lib/prisma");
class AppError extends Error {
    statusCode;
    constructor(statusCode, message) {
        super(message);
        this.statusCode = statusCode;
        this.name = 'AppError';
    }
}
exports.AppError = AppError;
class PMRoutingService {
    /**
     * Retrieves all PM location assignments for a company.
     */
    static async getAssignments(companyId) {
        return await prisma_1.prisma.pMLocationAssignment.findMany({
            where: { company_id: companyId },
            include: {
                pm: {
                    select: { id: true, full_name: true, email: true, phone: true }
                }
            },
            orderBy: { location: 'asc' }
        });
    }
    /**
     * Assigns a location to a PM.
     */
    static async assignLocation(companyId, pmId, location, level = 'CITY') {
        // Verify the PM exists and has the project manager role
        const pm = await prisma_1.prisma.employee.findFirst({
            where: {
                id: pmId,
                company_id: companyId,
                roles: {
                    some: {
                        role: { name: 'project managers' } // Matches the role in this codebase
                    }
                }
            }
        });
        if (!pm) {
            throw new AppError(404, 'Employee not found or is not a Project Manager');
        }
        // Check if the assignment already exists
        const existing = await prisma_1.prisma.pMLocationAssignment.findUnique({
            where: {
                pm_id_location_company_id: {
                    pm_id: pmId,
                    location: location,
                    company_id: companyId
                }
            }
        });
        if (existing) {
            throw new AppError(400, 'This location is already assigned to this PM');
        }
        return await prisma_1.prisma.pMLocationAssignment.create({
            data: {
                pm_id: pmId,
                location: location,
                level: level,
                company_id: companyId
            }
        });
    }
    /**
     * Removes a location assignment from a PM.
     */
    static async removeAssignment(companyId, id) {
        const assignment = await prisma_1.prisma.pMLocationAssignment.findFirst({
            where: { id: id, company_id: companyId }
        });
        if (!assignment) {
            throw new AppError(404, 'Location assignment not found');
        }
        await prisma_1.prisma.pMLocationAssignment.delete({
            where: { id: id }
        });
        return { success: true, message: 'Assignment removed successfully' };
    }
}
exports.PMRoutingService = PMRoutingService;
