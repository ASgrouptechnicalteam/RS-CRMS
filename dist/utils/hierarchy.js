"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isManagerOf = exports.getDownstreamEmployeeIds = void 0;
const prisma_1 = require("../lib/prisma");
/**
 * Safely resolves the recursive downstream team for a given manager.
 * Fetches the hierarchy in a single query per company to avoid N+1 problems.
 */
async function getDownstreamEmployeeIds(companyId, managerId) {
    // 1. Fetch all employees for this company in one go.
    // We only need id and reporting_manager_id.
    const allEmployees = await prisma_1.prisma.employee.findMany({
        where: { company_id: companyId },
        select: { id: true, reporting_manager_id: true }
    });
    // 2. Build an adjacency map: managerId -> array of direct report IDs
    const managerToReports = new Map();
    for (const emp of allEmployees) {
        if (emp.reporting_manager_id) {
            if (!managerToReports.has(emp.reporting_manager_id)) {
                managerToReports.set(emp.reporting_manager_id, []);
            }
            managerToReports.get(emp.reporting_manager_id).push(emp.id);
        }
    }
    // 3. Traverse to find all recursive downstream IDs
    const downstreamIds = new Set();
    const queue = [managerId];
    while (queue.length > 0) {
        const currentId = queue.shift();
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
exports.getDownstreamEmployeeIds = getDownstreamEmployeeIds;
/**
 * Checks if the given employeeId is in the downstream hierarchy of managerId.
 */
async function isManagerOf(managerId, employeeId) {
    const manager = await prisma_1.prisma.employee.findUnique({
        where: { id: managerId },
        select: { company_id: true }
    });
    if (!manager)
        return false;
    const downstreamIds = await getDownstreamEmployeeIds(manager.company_id, managerId);
    return downstreamIds.includes(employeeId);
}
exports.isManagerOf = isManagerOf;
