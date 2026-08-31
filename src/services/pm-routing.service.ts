import { PrismaClient } from '@prisma/client';
import { Roles } from '../shared';
import { prisma as p } from '../lib/prisma';

export class AppError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
    this.name = 'AppError';
  }
}

export class PMRoutingService {
  /**
   * Retrieves all PM location assignments for a company.
   */
  static async getAssignments(companyId: number) {
    return await p.pMLocationAssignment.findMany({
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
  static async assignLocation(companyId: number, pmId: number, location: string, level: string = 'CITY') {
    // Verify the PM exists and has the project manager role
    const pm = await p.employee.findFirst({
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
    const existing = await p.pMLocationAssignment.findUnique({
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

    return await p.pMLocationAssignment.create({
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
  static async removeAssignment(companyId: number, id: number) {
    const assignment = await p.pMLocationAssignment.findFirst({
      where: { id: id, company_id: companyId }
    });

    if (!assignment) {
      throw new AppError(404, 'Location assignment not found');
    }

    await p.pMLocationAssignment.delete({
      where: { id: id }
    });

    return { success: true, message: 'Assignment removed successfully' };
  }
}
