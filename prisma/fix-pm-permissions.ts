import { syncRolePermissions } from '../src/authz/syncRolePermissions';
import { prisma } from '../src/lib/prisma';

// Manual one-off entry point for syncRolePermissions — the same sync now
// also runs automatically on every server boot (see server.ts), so this
// script is kept only for running it on demand without restarting the server.
syncRolePermissions()
  .then(() => console.log('Done fixing permissions.'))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
