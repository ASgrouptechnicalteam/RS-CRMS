const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  const leads = await prisma.lead.findMany({select: {id: true, company_id: true}});
  console.log(leads);
}
main().finally(() => prisma.$disconnect());
