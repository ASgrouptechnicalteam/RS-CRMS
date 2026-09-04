import { PrismaClient } from '@prisma/client';
import { LeadService } from './src/services/lead.service';
import { Permissions, Roles } from './src/shared';

const prisma = new PrismaClient();

async function run() {
  console.log('Testing DEMO_SCHEDULED transition...');
  
  // 1. Get an active user to act as actor
  const employee = await prisma.employee.findFirst({
    where: { status: 'ACTIVE' }
  });
  
  if (!employee) {
    throw new Error('No active employee found for testing');
  }

  const userContext = {
    userId: 1,
    employeeId: employee.id,
    companyId: employee.company_id,
    roles: [Roles.TELECALLER, Roles.ADMIN],
    permissions: [Permissions.LEADS_CREATE, Permissions.LEADS_UPDATE, Permissions.LEADS_READ]
  } as any;

  // 2. Create a test lead
  const testPhone = `+919999${Math.floor(100000 + Math.random() * 900000)}`;
  console.log(`Creating test lead with phone ${testPhone}...`);
  const createResult = await LeadService.createLead(userContext, {
    customer_name: 'Test Demo Lead',
    phone: testPhone,
    source: 'MANUAL_ENTRY',
  }) as any;
  const lead = createResult.lead || createResult;

  console.log(`Created Lead ID: ${lead.id}`);

  // Bypass assignment for the test to ensure we have permission to mutate
  await prisma.lead.update({
    where: { id: lead.id },
    data: { assigned_to_id: employee.id }
  });

  // 3. Move through required states to reach DEMO_SCHEDULED
  // First, we need CALL_LOGGED activity to go to CONTACTED
  console.log('Updating to ASSIGNED...');
  await LeadService.updateLeadStatus(userContext, lead.id, 'ASSIGNED');

  console.log('Logging call...');
  await prisma.leadActivity.create({
    data: {
      lead_id: lead.id,
      actor_id: employee.id,
      activity_type: 'CALL_LOGGED',
      notes: 'Test call logged'
    }
  });

  console.log('Updating to CONTACTED...');
  await LeadService.updateLeadStatus(userContext, lead.id, 'CONTACTED');
  
  console.log('Updating to QUALIFIED...');
  await LeadService.updateLeadStatus(userContext, lead.id, 'QUALIFIED', undefined, {
    qualification: {
      budget_min: 100000,
      budget_max: 500000,
      property_type_preference: 'APARTMENT',
      preferred_location: 'Hyderabad'
    }
  });

  // 4. Finally, transition to DEMO_SCHEDULED
  console.log('Scheduling demo...');
  const updatedLead = await LeadService.updateLeadStatus(userContext, lead.id, 'DEMO_SCHEDULED', 'Scheduling demo test', {
    demo_scheduled_at: new Date(Date.now() + 86400000).toISOString(),
    demo_handler_id: employee.id
  });

  console.log('Lead updated to:', updatedLead.status);

  // 5. Verify the Demo record was created
  const demoRecord = await prisma.demo.findFirst({
    where: { lead_id: lead.id }
  });

  if (!demoRecord) {
    throw new Error('FAILED: Demo record was not created in the database.');
  }

  console.log('SUCCESS: Demo record created successfully!');
  console.log(demoRecord);
  
  // Cleanup
  console.log('Cleaning up test data...');
  await prisma.lead.delete({ where: { id: lead.id } });
  
  console.log('Done.');
}

run()
  .catch(e => {
    console.error('Test failed with error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
