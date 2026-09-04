import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  console.log('Searching for test leads...');
  
  // Find leads where name or email contains 'test' (case-insensitive)
  const testLeads = await prisma.lead.findMany({
    where: {
      OR: [
        { customer_name: { contains: 'test' } },
        { email: { contains: 'test' } }
      ]
    },
    select: { id: true, customer_name: true, status: true }
  });

  if (testLeads.length === 0) {
    console.log('No test leads found.');
    return;
  }

  console.log(`Found ${testLeads.length} test leads. Deleting...`);

  let deletedCount = 0;
  for (const lead of testLeads) {
    try {
      // First, nullify origin_lead_id in related Customer (if any)
      // because they don't have ON DELETE CASCADE in the schema.
      await prisma.customer.updateMany({
        where: { origin_lead_id: lead.id },
        data: { origin_lead_id: null }
      });

      // Now delete the lead. Cascade delete will handle Tasks, LeadActivities, etc.
      await prisma.lead.delete({
        where: { id: lead.id }
      });
      console.log(`Deleted lead: ${lead.customer_name} (ID: ${lead.id})`);
      deletedCount++;
    } catch (e: any) {
      console.error(`Failed to delete lead ID ${lead.id}:`, e.message);
    }
  }

  console.log(`Successfully deleted ${deletedCount} test leads.`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
