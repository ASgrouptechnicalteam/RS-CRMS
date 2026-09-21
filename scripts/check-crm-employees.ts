import { PrismaClient } from '@prisma/client';

async function main() {
  const crmDb = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL_PRODUCTION });
  try {
    const employees = await crmDb.employee.findMany();
    console.log('CRM_API Employees Status:');
    for (const emp of employees) {
      console.log(`ID: ${emp.id}, Code: ${emp.employee_code}, Status: ${emp.status}`);
    }
  } catch (e) {
    console.error(e);
  } finally {
    crmDb.$disconnect();
  }
}
main();
