const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  try {
    const res = await prisma.booking.findMany({
      where: {
        customer: {
          origin_lead: {
            OR: [
              { created_by_id: 1 },
              { assigned_to_id: 1 },
              {
                site_visits: {
                  some: {
                    OR: [
                      { telecaller_id: 1 },
                      { project_manager_id: 1 },
                      { assigned_agent_id: 1 }
                    ]
                  }
                }
              }
            ]
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
