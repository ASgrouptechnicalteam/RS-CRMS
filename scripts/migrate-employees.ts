import { PrismaClient } from '@prisma/client';

async function main() {
  const rsUrl = process.env.RS_DB_URL;
  const crmUrl = process.env.CRM_DB_URL;

  if (!rsUrl || !crmUrl) {
    console.error('Error: RS_DB_URL and CRM_DB_URL environment variables must be provided.');
    console.error(
      'Usage: RS_DB_URL="..." CRM_DB_URL="..." npx ts-node scripts/migrate-employees.ts',
    );
    process.exit(1);
  }

  const rsDb = new PrismaClient({ datasourceUrl: rsUrl });
  const crmDb = new PrismaClient({ datasourceUrl: crmUrl });

  try {
    // 1. Deactivate existing employees in CRM_API
    const crmEmployees = await crmDb.employee.findMany();
    console.log(`Found ${crmEmployees.length} employees in CRM_API. Deactivating...`);
    for (const emp of crmEmployees) {
      if (emp.status !== 'INACTIVE') {
        await crmDb.employee.update({
          where: { id: emp.id },
          data: { status: 'INACTIVE' },
        });
        console.log(`Deactivated employee ID ${emp.id} (${emp.email || emp.employee_code})`);
      }
    }

    const crmEmployeeIds = new Set(crmEmployees.map((e) => e.id));

    // 2. Fetch all employees and related data from RS_DB
    console.log('Fetching employees from RS_DB...');
    const rsEmployees = await rsDb.employee.findMany({
      include: {
        roles: true,
        branches: true,
        company_access: true,
        permission_overrides: true,
        qr_codes: true,
        attendance_logs: true,
      },
    });

    console.log(`Found ${rsEmployees.length} employees in RS_DB. Migrating...`);

    let nextId = Math.max(...crmEmployees.map((e) => e.id), ...rsEmployees.map((e) => e.id)) + 1;
    const idMap = new Map<number, number>();

    // 3. Migrate employees
    for (const emp of rsEmployees) {
      // Check for ID collision
      let targetId = emp.id;

      // If the ID already exists in CRM_API, we MUST remap it to prevent overwriting the admin
      // and breaking their properties.
      if (crmEmployeeIds.has(emp.id)) {
        targetId = nextId++;
        idMap.set(emp.id, targetId);
        console.log(
          `ID Collision for ${emp.employee_code}: Mapping RS_DB ID ${emp.id} -> CRM_API ID ${targetId}`,
        );
      } else {
        idMap.set(emp.id, targetId); // Map to self
      }

      // Check if employee code already exists in CRM (should not happen if they are unique, but just in case)
      const existingCode = await crmDb.employee.findUnique({
        where: { employee_code: emp.employee_code },
      });
      if (existingCode && existingCode.id !== targetId) {
        console.warn(
          `WARNING: Employee code ${emp.employee_code} already exists in CRM_API. Skipping insert.`,
        );
        continue;
      }

      const {
        roles,
        branches,
        company_access,
        permission_overrides,
        qr_codes,
        attendance_logs,
        id, // Extract old ID
        ...employeeData // The rest of the fields
      } = emp;

      // Upsert the employee
      console.log(`Migrating employee ${emp.employee_code} (Target ID: ${targetId})...`);
      await crmDb.employee.upsert({
        where: { id: targetId },
        update: { ...employeeData, status: emp.status }, // Restore their original status from RS_DB
        create: { id: targetId, ...employeeData },
      });

      // Migrate Roles
      if (roles.length > 0) {
        await crmDb.employeeRole.deleteMany({ where: { employee_id: targetId } });
        await crmDb.employeeRole.createMany({
          data: roles.map((r) => ({ ...r, employee_id: targetId })),
        });
      }

      // Migrate Branches
      if (branches.length > 0) {
        await crmDb.employeeBranch.deleteMany({ where: { employee_id: targetId } });
        await crmDb.employeeBranch.createMany({
          data: branches.map((b) => ({ ...b, employee_id: targetId })),
        });
      }

      // Migrate Company Access
      if (company_access.length > 0) {
        await crmDb.employeeCompanyAccess.deleteMany({ where: { employee_id: targetId } });
        await crmDb.employeeCompanyAccess.createMany({
          data: company_access.map((c) => ({ ...c, employee_id: targetId })),
        });
      }

      // Migrate Permission Overrides
      if (permission_overrides.length > 0) {
        await crmDb.employeePermissionOverride.deleteMany({ where: { employee_id: targetId } });
        await crmDb.employeePermissionOverride.createMany({
          data: permission_overrides.map((p) => ({ ...p, employee_id: targetId, id: undefined })), // Let ID auto-increment
        });
      }

      // Migrate QR Codes
      if (qr_codes.length > 0) {
        await crmDb.employeeQrCode.deleteMany({ where: { employee_id: targetId } });
        await crmDb.employeeQrCode.createMany({
          data: qr_codes.map((q) => ({ ...q, employee_id: targetId, id: undefined })),
        });
      }

      // Migrate Attendance Logs
      if (attendance_logs.length > 0) {
        await crmDb.attendanceLog.deleteMany({ where: { employee_id: targetId } });
        await crmDb.attendanceLog.createMany({
          data: attendance_logs.map((a) => ({ ...a, employee_id: targetId, id: undefined })),
        });
      }
    }

    console.log('✅ Migration completed successfully!');
  } catch (err) {
    console.error('Migration failed:', err);
  } finally {
    await rsDb.$disconnect();
    await crmDb.$disconnect();
  }
}

main();
