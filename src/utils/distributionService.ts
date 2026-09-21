import { logger } from './logger';
import { prisma } from '../lib/prisma';
import { Roles } from '../shared';

const p = prisma;

export interface DistributionCandidate {
  employeeId: number;
  employeeCode: string;
  name: string;
  weight: number;
  activeLeadCount: number;
  isNewJoiner: boolean;
}

/**
 * Performance-Weighted Distribution Service for Phase 3
 * Weight = Performance Score + (7-Day Call Boost) + (New Joiner Quota Boost) - (Active Load Penalty)
 */
export const findBestAssigneeForLead = async (
  companyId: number,
  preferredPmId?: number,
): Promise<DistributionCandidate | null> => {
  try {
    // If a specific PM is preferred for project-linked leads
    if (preferredPmId) {
      const preferredPm = await p.employee.findFirst({
        where: { id: preferredPmId, company_id: companyId, status: 'ACTIVE' },
      });
      if (preferredPm) {
        const activeCount = await p.lead.count({
          where: {
            assigned_to_id: preferredPm.id,
            status: { in: ['NEW', 'ASSIGNED', 'CONTACTED', 'QUALIFIED'] },
          },
        });
        return {
          employeeId: preferredPm.id,
          employeeCode: preferredPm.employee_code,
          name: preferredPm.full_name || preferredPm.employee_code,
          weight: 100,
          activeLeadCount: activeCount,
          isNewJoiner: false,
        };
      }
    }

    // 1. Fetch all active Telecallers candidates
    const telecallers = await p.employee.findMany({
      where: {
        company_id: companyId,
        status: 'ACTIVE',
        roles: {
          some: {
            role: {
              name: Roles.TELECALLER,
            },
          },
        },
      },
      include: {
        performance_snapshots: { orderBy: { snapshot_date: 'desc' }, take: 1 },
        daily_reports: { where: { submitted_at: { gte: new Date(Date.now() - 7 * 86400000) } } },
      },
    });

    if (telecallers.length === 0) {
      // Safe Fallback: If no eligible Telecallers exist, safely return null.
      // This allows the Lead Service to place the Lead in the 'NEW' (Unassigned) pool.
      return null;
    }

    const candidates: DistributionCandidate[] = [];

    for (const emp of telecallers) {
      const activeLeadCount = await p.lead.count({
        where: {
          assigned_to_id: emp.id,
          status: { in: ['NEW', 'ASSIGNED', 'CONTACTED', 'QUALIFIED', 'SITE_VISIT_SCHEDULED'] },
        },
      });

      // Equal Load Distribution (Phase 19 Update)
      // We no longer use performance weighting for assignment. We just find the telecaller
      // with the lowest activeLeadCount.
      const daysSinceJoining = emp.date_of_joining
        ? (Date.now() - new Date(emp.date_of_joining).getTime()) / (1000 * 3600 * 24)
        : 0;
      const isNewJoiner = daysSinceJoining > 0 && daysSinceJoining < 30;

      candidates.push({
        employeeId: emp.id,
        employeeCode: emp.employee_code,
        name: emp.full_name || emp.employee_code,
        weight: 0, // Unused now, but kept for interface compatibility
        activeLeadCount,
        isNewJoiner,
      });
    }

    // Sort by lowest active lead count first
    candidates.sort((a, b) => a.activeLeadCount - b.activeLeadCount);

    return candidates[0] || null;
  } catch (err: any) {
    logger.error('Error in distribution algorithm:', err.message);
    return null;
  }
};
