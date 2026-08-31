import { prisma } from '../lib/prisma';
import { PrismaClient, Prisma } from '@prisma/client';
import { TokenPayload } from '../utils/jwt';
import { buildProjectScope } from '../authz/dataScope';
import { ProjectCreateInput, ProjectUpdateInput, Roles, Permissions } from '../shared';
import { can } from '../authz/authorization';
import { slugify, generateUniqueSlug } from '../utils/slugify';


const p = prisma;

export class ProjectService {
  private static async generateNextProjectCode(): Promise<string> {
    const currentYear = new Date().getFullYear();
    const count = await p.project.count();
    const seq = (count + 1).toString().padStart(4, '0');
    return `RRH-PJ-${currentYear}-${seq}`;
  }

  static async listProjects(user: TokenPayload, filters: { status?: string }, take: number = 50, skip: number = 0) {
    const whereCondition = await buildProjectScope(user);

    if (filters.status) {
      whereCondition.status = filters.status;
    }

    return await p.project.findMany({
      where: whereCondition,
      take,
      skip,
      include: {
        assigned_pm: { select: { id: true, employee_code: true, full_name: true, phone: true } },
      },
      orderBy: { created_at: 'desc' },
    });
  }

  static async getProject(user: TokenPayload, projectId: number) {
    const whereCondition = await buildProjectScope(user);
    
    const project = await p.project.findFirst({
      where: {
        id: projectId,
        ...whereCondition,
      },
      include: {
        assigned_pm: { select: { id: true, employee_code: true, full_name: true, phone: true } },
        properties: {
          select: {
            id: true,
            property_code: true,
            title: true,
            status: true,
          }
        }
      }
    });

    if (!project) throw { status: 404, message: 'Project not found or unauthorized' };
    return project;
  }

  static async createProject(user: TokenPayload, data: ProjectCreateInput) {
    const companyId = user.companyId || 1;
    const branchId = user.branchId || null;

    if (data.assigned_pm_id) {
      const pm = await p.employee.findFirst({
        where: { id: data.assigned_pm_id, company_id: companyId }
      });
      if (!pm) throw { status: 400, message: 'Invalid assigned_pm_id or does not belong to your company' };
    }

    const baseSlug = slugify(`${data.name} ${data.location}`);
    const slug = await generateUniqueSlug(baseSlug, companyId, async (s: string, cId: number) => {
      const existing = await p.project.findFirst({ where: { slug: s, company_id: cId } });
      return !!existing;
    });

    const MAX_RETRIES = 3;
    let retries = 0;

    while (retries < MAX_RETRIES) {
      try {
        const projectCode = await this.generateNextProjectCode();
        
        const project = await p.project.create({
          data: {
            project_code: projectCode,
            company_id: companyId,
            branch_id: branchId,
            name: data.name,
            description: data.description || null,
            location: data.location,
            total_area: data.total_area || null,
            launch_date: data.launch_date ? new Date(data.launch_date) : null,
            amenities: data.amenities || null,
            assigned_pm_id: data.assigned_pm_id || null,
            status: 'PLANNING',
            slug,
          },
        });
        
        return project;
      } catch (error: any) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          // Unique constraint violation (likely project_code collision due to concurrency)
          const target = error.meta?.target as string[];
          if (target && target.includes('project_code')) {
            retries++;
            continue; // Retry with a new code
          }
        }
        // If it's a different error or not a project_code collision, throw it
        throw error;
      }
    }

    throw { status: 500, message: 'Failed to generate unique project code after multiple retries' };
  }

  static async updateProject(user: TokenPayload, projectId: number, data: ProjectUpdateInput) {
    const whereCondition = await buildProjectScope(user);

    const project = await p.project.findFirst({
      where: {
        id: projectId,
        ...whereCondition,
      }
    });

    if (!project) throw { status: 404, message: 'Project not found or unauthorized' };

    if (data.assigned_pm_id && data.assigned_pm_id !== project.assigned_pm_id) {
      const pm = await p.employee.findFirst({
        where: { id: data.assigned_pm_id, company_id: user.companyId }
      });
      if (!pm) throw { status: 400, message: 'Invalid assigned_pm_id or does not belong to your company' };
    }

    const updateData: any = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.description !== undefined) updateData.description = data.description;
    if (data.location !== undefined) updateData.location = data.location;
    if (data.total_area !== undefined) updateData.total_area = data.total_area;
    if (data.launch_date !== undefined) updateData.launch_date = data.launch_date ? new Date(data.launch_date) : null;
    if (data.status !== undefined) updateData.status = data.status;
    if (data.amenities !== undefined) updateData.amenities = data.amenities;
    if (data.assigned_pm_id !== undefined) updateData.assigned_pm_id = data.assigned_pm_id;

    return await p.project.update({
      where: { id: projectId },
      data: updateData,
    });
  }

  static async deleteProject(user: TokenPayload, projectId: number) {
    const whereCondition = await buildProjectScope(user);

    const project = await p.project.findFirst({
      where: {
        id: projectId,
        ...whereCondition,
      }
    });

    if (!project) throw { status: 404, message: 'Project not found or unauthorized' };

    return await p.project.update({
      where: { id: projectId },
      data: { status: 'CANCELLED' }
    });
  }

  static async reassignProject(user: TokenPayload, projectId: number, newPmId: number, reason: string) {
    if (!can(user, Permissions.PROJECTS_UPDATE)) { 
      throw { status: 403, message: 'Forbidden: Missing permission to reassign project' };
    }
    if (!reason || reason.trim() === '') {
      throw { status: 400, message: 'Reassignment reason is mandatory' };
    }

    const project = await p.project.findFirst({
      where: { id: projectId, company_id: user.companyId }
    });
    if (!project) throw { status: 404, message: 'Project not found or unauthorized' };

    const newPm = await p.employee.findFirst({
      where: { id: newPmId, company_id: user.companyId, status: 'ACTIVE' }
    });
    if (!newPm) throw { status: 400, message: 'New assignee not found or unauthorized' };

    const oldPmId = project.assigned_pm_id;

    return await p.$transaction(async (tx: import('@prisma/client').Prisma.TransactionClient) => {
      const updated = await tx.project.update({
        where: { id: projectId },
        data: { assigned_pm_id: newPmId }
      });

      await tx.auditEvent.create({
        data: {
          actor_id: user.employeeId!,
          action: 'REASSIGNMENT',
          entity_type: 'PROJECT',
          entity_id: projectId,
          old_value: oldPmId ? oldPmId.toString() : 'UNASSIGNED',
          new_value: newPmId.toString(),
          reason: reason
        }
      });

      return updated;
    });
  }
}
