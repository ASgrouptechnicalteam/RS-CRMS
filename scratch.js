const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  try {
    const res = await prisma.booking.findMany({
      where: {
        customer: {
          origin_lead: {
            is: {
              OR: [
                { created_by_id: 1 }
              ]
            }
          }
        }
      }
    });
    console.log('success');
  } catch(e) {
    console.error('failed:', e.message);
  }
}
main().catch(console.error).finally(() => prisma.$disconnect());
