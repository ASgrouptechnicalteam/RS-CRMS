import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { Roles } from '@rrh-ems/shared';


// PrismaClient instance shared across seed fixtures
const prisma = new PrismaClient();

/**
 * CONFIGURABLE SEED DATA FOR RADHA REAL HOMES & SONTHILLU
 */
const COMPANY_CONFIG = {
  name: 'Radha Real Homes',
  code: 'RRH',
  property_type_group: 'RADHA_REAL_HOMES',
};

const INITIAL_BRANCHES = [
  { name: 'Miyapur (Main Branch)' },
  { name: 'Tarnaka Branch' },
];

const DEFAULT_PASSWORD = process.env.DEFAULT_ADMIN_PASSWORD;

async function main() {
  console.log('🌱 Seeding Admin Team for Radha Real Homes & Sonthillu...');

  // 1. Create or Update Company
  const company = await prisma.company.upsert({
    where: { code: COMPANY_CONFIG.code },
    update: { name: COMPANY_CONFIG.name },
    create: {
      name: COMPANY_CONFIG.name,
      code: COMPANY_CONFIG.code,
      property_type_group: COMPANY_CONFIG.property_type_group,
    },
  });

  // 2. Create Branches
  const createdBranches: any[] = [];
  for (const branchData of INITIAL_BRANCHES) {
    const existingBranch = await prisma.branch.findFirst({
      where: { company_id: company.id, name: branchData.name },
    });

    const branch = existingBranch
      ? existingBranch
      : await prisma.branch.create({
          data: {
            company_id: company.id,
            name: branchData.name,
          },
        });
    createdBranches.push(branch);
  }

  // 3. Seed System Roles
  const rolesToSeed = [
    { name: Roles.MD, is_system: true, is_invisible: false },
    { name: Roles.ADMIN, is_system: true, is_invisible: true },
    { name: Roles.HR_MANAGER, is_system: false, is_invisible: false },
    { name: Roles.MARKETING_DIRECTOR, is_system: false, is_invisible: false },
    { name: Roles.PROJECT_MANAGER, is_system: false, is_invisible: false },
    { name: Roles.DIGITAL_LEAD_OPERATOR, is_system: false, is_invisible: false },
    { name: Roles.TELECALLER, is_system: false, is_invisible: false },
    { name: Roles.DIGITAL_MARKETING_HEAD, is_system: false, is_invisible: false },
    { name: Roles.FINANCE, is_system: false, is_invisible: false },
    { name: Roles.AGENT, is_system: false, is_invisible: false },
    { name: Roles.DIGITAL_MARKETING_EXECUTIVE, is_system: false, is_invisible: false },
    { name: Roles.SALES_MANAGER, is_system: false, is_invisible: false },
    { name: Roles.CHANNEL_PARTNER_MANAGER, is_system: false, is_invisible: false },
  ];

  const roleMap: Record<string, any> = {};
  for (const roleDef of rolesToSeed) {
    const role = await prisma.role.upsert({
      where: { name: roleDef.name },
      update: { is_invisible: roleDef.is_invisible, is_system: roleDef.is_system },
      create: roleDef,
    });
    roleMap[roleDef.name] = role;
  }

  console.log('🔒 Seeding canonical RBAC permissions...');
  // Import dynamically to avoid top-level issues if shared isn't built yet, though seed.ts already imports from it
  const sharedModule = await import('@rrh-ems/shared');
  const Permissions = sharedModule.Permissions || {};
  const RolePermissionsMatrix = sharedModule.RolePermissionsMatrix || {};

  const allPerms = Object.values(Permissions);
  for (const permName of allPerms) {
    if (typeof permName === 'string') {
      await prisma.permission.upsert({
        where: { name: permName },
        update: {},
        create: { name: permName }
      });
    }
  }

  // Clear existing role permissions to ensure exact sync
  await prisma.rolePermission.deleteMany({});
  
  for (const [roleName, permissions] of Object.entries(RolePermissionsMatrix)) {
    const roleRecord = roleMap[roleName];
    if (roleRecord && Array.isArray(permissions)) {
      for (const perm of permissions) {
        const permRecord = await prisma.permission.findUnique({ where: { name: perm } });
        if (permRecord) {
          await prisma.rolePermission.create({
            data: {
              role_id: roleRecord.id,
              permission_id: permRecord.id
            }
          });
        }
      }
    }
  }

  if (!DEFAULT_PASSWORD) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('FATAL: DEFAULT_ADMIN_PASSWORD must be provided in production for seeding.');
    }
    console.warn('WARNING: Using insecure default admin password for development seeding.');
  }
  const passwordHash = await bcrypt.hash(DEFAULT_PASSWORD || 'Radhareal@123', 12);

  // 4. Seed Admin
  const initialEmployees = [
    {
      roleName: Roles.ADMIN,
      employeeCode: 'RRH-ADMIN-001',
      branchId: createdBranches[0]?.id,
      attendanceRequired: false,
    }
  ];

  for (const empData of initialEmployees) {
    const existingEmp = await prisma.employee.findUnique({
      where: { employee_code: empData.employeeCode },
    });

    if (!existingEmp) {
      const emp = await prisma.employee.create({
        data: {
          employee_code: empData.employeeCode,
          company_id: company.id,
          branch_id: empData.branchId,
          password_hash: passwordHash,
          status: 'ACTIVE',
          attendance_required: empData.attendanceRequired,
          first_login_done: true,
          roles: {
            create: {
              role_id: roleMap[empData.roleName].id,
            },
          },
        },
      });
      console.log(`✅ Employee created: ${emp.employee_code} (${empData.roleName})`);
    } else {
      await prisma.employee.update({
        where: { id: existingEmp.id },
        data: {
          attendance_required: empData.attendanceRequired,
          first_login_done: true,
        },
      });
      console.log(`✅ Employee updated: ${existingEmp.employee_code}`);
    }
  }

    console.log('✅ Core RRH seed completed successfully.');

  // Step 5: Conditionally run Sonthillu E2E local fixtures (development only).
  if (process.env.NODE_ENV !== 'production') {
    const { runSonthilluE2EFixtures } = await import('./fixtures/sonthillu-e2e.fixtures');
    await runSonthilluE2EFixtures(prisma);

    // Step 6: Conditionally run Development Fixtures (development only).
    const { runDevelopmentFixtures } = await import('./fixtures/development-data.fixtures');
    await runDevelopmentFixtures(prisma);
  }
}

main()
  .catch((e) => {
    console.error('Seed script error:', e);
    throw e;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
