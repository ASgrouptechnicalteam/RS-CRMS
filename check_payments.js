const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  const total = await prisma.payment.count();
  const nullRef = await prisma.payment.count({ where: { reference_number: null } });
  const grouped = await prisma.payment.groupBy({
    by: ['reference_number'],
    having: { reference_number: { _count: { gt: 1 } } },
    where: { reference_number: { not: null } }
  });
  console.log('Total Payments:', total);
  console.log('Null reference_number:', nullRef);
  console.log('Duplicates:', grouped);
}
main().catch(console.error).finally(() => prisma.$disconnect());
