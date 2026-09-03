const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function migrateStatus() {
  try {
    const leads = await prisma.lead.findMany({
      where: { status: 'QUALIFICATION_PENDING' }
    });
    console.log(`Found ${leads.length} leads in QUALIFICATION_PENDING.`);
    
    if (leads.length > 0) {
      const res = await prisma.lead.updateMany({
        where: { status: 'QUALIFICATION_PENDING' },
        data: { status: 'CONTACTED' }
      });
      console.log(`Successfully migrated ${res.count} leads to CONTACTED.`);
      
      // Also update activities that might be holding this status if necessary, 
      // but usually the main lead status is the critical part.
      // But let's log activities too just in case.
      const actRes = await prisma.leadActivity.updateMany({
        where: { activity_type: 'STATUS_CHANGED', new_value: 'QUALIFICATION_PENDING' },
        data: { new_value: 'CONTACTED' }
      });
      console.log(`Migrated ${actRes.count} activity logs to CONTACTED.`);
    }
  } catch (e) {
    console.error(e);
  } finally {
    await prisma.$disconnect();
  }
}

migrateStatus();
