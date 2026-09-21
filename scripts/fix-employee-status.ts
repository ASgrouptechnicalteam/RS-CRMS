import { PrismaClient } from '@prisma/client';

async function main() {
  const crmDb = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL_PRODUCTION });
  try {
    const result = await crmDb.employee.updateMany({
      where: {
        id: { not: 1 }, // Do not update the admin
      },
      data: { status: 'ACTIVE' },
    });
    console.log(`Activated ${result.count} employees.`);

    // Deactivate admin explicitly just in case
    await crmDb.employee.update({
      where: { id: 1 },
      data: { status: 'INACTIVE' },
    });
    console.log('Admin employee (ID 1) set to INACTIVE.');
  } catch (e) {
    console.error(e);
  } finally {
    crmDb.$disconnect();
  }
}
main();
