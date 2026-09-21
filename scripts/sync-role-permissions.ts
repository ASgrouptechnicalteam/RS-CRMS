import { PrismaClient } from '@prisma/client';
import { DEFAULT_ROLE_PERMISSIONS, Roles } from '../src/shared/auth';

const prisma = new PrismaClient();

async function syncRolePermissions() {
  console.log('Starting role permissions sync...');

  try {
    // 1. Fetch all roles from DB
    const dbRoles = await prisma.role.findMany();
    console.log(`Found ${dbRoles.length} roles in database.`);

    let updatedCount = 0;

    for (const dbRole of dbRoles) {
      // Cast the string to our Roles enum/type. If it's not a standard role, we skip or log.
      const roleName = dbRole.name as Roles;

      if (!DEFAULT_ROLE_PERMISSIONS[roleName]) {
        console.warn(
          `⚠️ Role '${dbRole.name}' found in DB but has no defined permissions in auth.ts. Skipping.`,
        );
        continue;
      }

      const expectedPermissions = DEFAULT_ROLE_PERMISSIONS[roleName];

      // 2. Clear existing permissions for this role
      await prisma.rolePermission.deleteMany({
        where: { role_id: dbRole.id },
      });

      // 3. Insert the exact expected permissions
      if (expectedPermissions.length > 0) {
        await prisma.rolePermission.createMany({
          data: expectedPermissions.map((permission) => ({
            role_id: dbRole.id,
            permission_name: permission,
          })),
        });
      }

      console.log(`✅ Synced ${expectedPermissions.length} permissions for role: ${dbRole.name}`);
      updatedCount++;
    }

    console.log(`\n🎉 Sync complete. Updated ${updatedCount} standard roles.`);
  } catch (error) {
    console.error('Error syncing role permissions:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

syncRolePermissions();
