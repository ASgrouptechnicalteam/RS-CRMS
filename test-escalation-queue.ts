import { prisma } from './src/lib/prisma';
import { SiteVisitService } from './src/services/siteVisit.service';

const Roles = {
  MANAGING_DIRECTOR: 'MANAGING_DIRECTOR'
};

async function runTest() {
  console.log('Testing MD Escalation Queue logic...');
  
  // 1. Get an MD user to act as
  const md = await prisma.employee.findFirst({
    where: { roles: { some: { role: { name: Roles.MANAGING_DIRECTOR } } } },
    include: { company: true }
  });
  if (!md) throw new Error('No MD found');

  const mdToken = { employeeId: md.id, companyId: md.company_id, roles: [Roles.MANAGING_DIRECTOR] };

  // 2. Fetch the escalation queue before
  const visitsBefore = await SiteVisitService.listVisits(mdToken as any, { escalated: true });
  console.log(`Visits in escalation queue: ${visitsBefore.length}`);
  
  if (visitsBefore.length === 0) {
    console.log('No escalated visits to test with. Creating a fake escalation on the first PENDING_ACCEPTANCE visit...');
    
    const visit = await prisma.siteVisitBooking.findFirst({
      where: { status: 'PENDING_ACCEPTANCE' }
    });
    
    if (visit) {
      await prisma.siteVisitEscalation.create({
        data: {
          visit_id: visit.id,
          marketing_director_notified_at: new Date(),
        }
      });
      console.log(`Created fake escalation for visit ID ${visit.id}`);
      
      const visitsAfterEscalation = await SiteVisitService.listVisits(mdToken as any, { escalated: true });
      console.log(`Visits in escalation queue after fake escalation: ${visitsAfterEscalation.length}`);
    } else {
      console.log('No PENDING_ACCEPTANCE visits found to test with.');
      return;
    }
  }

  const visitsNow = await SiteVisitService.listVisits(mdToken as any, { escalated: true });
  const testVisit = visitsNow[0];
  
  if (testVisit) {
    console.log(`Testing with visit ID ${testVisit.id} (Status: ${testVisit.status})`);
    
    // Accept the visit (simulate MD routing it to themselves or someone else accepting)
    // We'll just transition it directly to simulate it moving out of unresolved state
    await prisma.siteVisitBooking.update({
      where: { id: testVisit.id },
      data: { status: 'ACCEPTED', project_manager_id: md.id }
    });
    console.log(`Updated visit ID ${testVisit.id} to ACCEPTED`);
    
    const visitsAfterAccept = await SiteVisitService.listVisits(mdToken as any, { escalated: true });
    console.log(`Visits in escalation queue after accept: ${visitsAfterAccept.length}`);
    
    const isStillInQueue = visitsAfterAccept.some(v => v.id === testVisit.id);
    console.log(`Is visit ${testVisit.id} still in queue? ${isStillInQueue ? 'YES (FAIL)' : 'NO (PASS)'}`);
    
    // Clean up
    await prisma.siteVisitBooking.update({
      where: { id: testVisit.id },
      data: { status: testVisit.status, project_manager_id: testVisit.project_manager_id }
    });
    console.log(`Reverted visit ID ${testVisit.id} to original state`);
  }
}

runTest().catch(console.error).finally(() => process.exit(0));
