const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  const leads = await prisma.lead.count();
  const customers = await prisma.customer.count();
  console.log('Total Leads:', leads);
  console.log('Total Customers:', customers);
  const byStatus = await prisma.lead.groupBy({
    by: ['status'],
    _count: true
  });
  console.log('Leads by Status:', byStatus);
}
main().finally(() => prisma.$disconnect());
