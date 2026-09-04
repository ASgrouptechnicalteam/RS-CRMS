const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  const count = await prisma.lead.count();
  console.log('Total leads:', count);
  const countsByEmp = await prisma.lead.groupBy({ by: ['created_by_id', 'assigned_to_id'], _count: { id: true } });
  console.log('By employee:', countsByEmp);
}
main().catch(console.error).finally(() => prisma.$disconnect());
