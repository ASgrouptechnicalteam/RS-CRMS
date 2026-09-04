const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  const allLeads = await prisma.lead.findMany({
    select: { id: true, company_id: true, created_by_id: true, assigned_to_id: true }
  });
  console.log('All Leads:', allLeads);
}
main().catch(console.error).finally(() => prisma.$disconnect());
