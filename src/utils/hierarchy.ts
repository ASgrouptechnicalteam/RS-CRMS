import { prisma } from '../lib/prisma';



/**
 * Safely resolves the recursive downstream team for a given manager.
 * Fetches the hierarchy in a single query per company to avoid N+1 problems.
 */
export async function getDownstreamEmployeeIds(companyId: number, managerId: number): Promise<number[]> {
  // 1. Fetch all employees for this company in one go.
  // We only need id and reporting_manager_id.
  const allEmployees = await prisma.employee.findMany({
    where: { company_id: companyId },
    select: { id: true, reporting_manager_id: true }
  });

  // 2. Build an adjacency map: managerId -> array of direct report IDs
  const managerToReports = new Map<number, number[]>();
  for (const emp of allEmployees) {
    if (emp.reporting_manager_id) {
      if (!managerToReports.has(emp.reporting_manager_id)) {
        managerToReports.set(emp.reporting_manager_id, []);
      }
      managerToReports.get(emp.reporting_manager_id)!.push(emp.id);
    }
  }

  // 3. Traverse to find all recursive downstream IDs
  const downstreamIds = new Set<number>();
  const queue = [managerId];

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    // Prevent cycles
    if (!downstreamIds.has(currentId) && currentId !== managerId) {
      downstreamIds.add(currentId);
    }

    const reports = managerToReports.get(currentId) || [];
    for (const reportId of reports) {
      if (!downstreamIds.has(reportId) && reportId !== managerId) {
        queue.push(reportId);
      }
    }
  }

  // Always include the manager themselves in their own team scope
  downstreamIds.add(managerId);

  return Array.from(downstreamIds);
}

/**
 * Checks if the given employeeId is in the downstream hierarchy of managerId.
 */
export async function isManagerOf(managerId: number, employeeId: number): Promise<boolean> {
  const manager = await prisma.employee.findUnique({
    where: { id: managerId },
    select: { company_id: true }
  });
  if (!manager) return false;
  
  const downstreamIds = await getDownstreamEmployeeIds(manager.company_id, managerId);
  return downstreamIds.includes(employeeId);
}
