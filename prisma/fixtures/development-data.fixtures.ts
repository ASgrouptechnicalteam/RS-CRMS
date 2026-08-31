import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { Roles } from '@rrh-ems/shared';

export async function runDevelopmentFixtures(prisma: PrismaClient) {
  console.log('🌱 Seeding Realistic Development Dataset...');

  const company = await prisma.company.findUnique({
    where: { code: 'RRH' },
  });

  if (!company) {
    console.error('Core company not found, skipping dev fixtures.');
    return;
  }

  const roleMap: Record<string, number> = {};
  const roles = await prisma.role.findMany();
  roles.forEach((r) => {
    roleMap[r.name] = r.id;
  });

  const branch = await prisma.branch.findFirst({
    where: { company_id: company.id },
  });

  if (!branch) {
    console.error('No branch found, skipping dev fixtures.');
    return;
  }

  const passwordHash = await bcrypt.hash(process.env.DEFAULT_ADMIN_PASSWORD || 'Radhareal@123', 12);

  // 1. Employees
  const employeeData = [
    { code: 'RRH-EMP-001', name: 'Alice Salesmgr', email: 'alice@example.com', role: Roles.SALES_MANAGER, phone: '9876543210' },
    { code: 'RRH-EMP-002', name: 'Bob Salesexec', email: 'bob@example.com', role: Roles.AGENT, phone: '9876543211' },
    { code: 'RRH-EMP-003', name: 'Carol Telecaller', email: 'carol@example.com', role: Roles.TELECALLER, phone: '9876543212' },
    { code: 'RRH-EMP-004', name: 'Dave Projmgr', email: 'dave@example.com', role: Roles.PROJECT_MANAGER, phone: '9876543213' },
  ];

  const createdEmployees: Record<string, any> = {};

  for (const emp of employeeData) {
    if (!roleMap[emp.role]) {
      console.warn(`Role ${emp.role} not found, skipping employee ${emp.code}`);
      continue;
    }
    const created = await prisma.employee.upsert({
      where: { employee_code: emp.code },
      update: {
        full_name: emp.name,
        email: emp.email,
        phone: emp.phone,
      },
      create: {
        employee_code: emp.code,
        company_id: company.id,
        branch_id: branch.id,
        password_hash: passwordHash,
        status: 'ACTIVE',
        full_name: emp.name,
        email: emp.email,
        phone: emp.phone,
        roles: {
          create: {
            role_id: roleMap[emp.role],
          },
        },
      },
    });
    createdEmployees[emp.code] = created;
    console.log(`✅ Employee upserted: ${emp.code}`);
  }

  // 2. Projects
  const projectData = [
    { code: 'PRJ-LAKE-01', name: 'Lakeside Villas', location: 'Kompally', status: 'UNDER_CONSTRUCTION' },
    { code: 'PRJ-TWR-01', name: 'Skyline Towers', location: 'Gachibowli', status: 'PLANNING' },
  ];

  const createdProjects: any[] = [];
  for (const proj of projectData) {
    const p = await prisma.project.upsert({
      where: { project_code: proj.code },
      update: {
        name: proj.name,
        location: proj.location,
        status: proj.status,
      },
      create: {
        project_code: proj.code,
        company_id: company.id,
        branch_id: branch.id,
        name: proj.name,
        location: proj.location,
        status: proj.status,
        slug: proj.code.toLowerCase(),
        assigned_pm_id: createdEmployees['RRH-EMP-004']?.id,
      },
    });
    createdProjects.push(p);
    console.log(`✅ Project upserted: ${proj.code}`);
  }

  // 3. Properties
  const propertyData = [
    // Project 1
    { code: 'PROP-LK-101', title: 'Villa 101 Lakeview', projIndex: 0, price: 15000000, area: 2500, type: 'VILLA' },
    { code: 'PROP-LK-102', title: 'Villa 102 Lakeview', projIndex: 0, price: 15500000, area: 2600, type: 'VILLA' },
    { code: 'PROP-LK-103', title: 'Villa 103 Standard', projIndex: 0, price: 14000000, area: 2400, type: 'VILLA' },
    { code: 'PROP-LK-104', title: 'Villa 104 Standard', projIndex: 0, price: 14000000, area: 2400, type: 'VILLA' },
    { code: 'PROP-LK-105', title: 'Villa 105 Corner', projIndex: 0, price: 16000000, area: 2800, type: 'VILLA' },
    
    // Project 2
    { code: 'PROP-SK-101', title: 'Apt 101 Skyline', projIndex: 1, price: 8000000, area: 1200, type: 'APARTMENT' },
    { code: 'PROP-SK-102', title: 'Apt 102 Skyline', projIndex: 1, price: 8500000, area: 1300, type: 'APARTMENT' },
    { code: 'PROP-SK-103', title: 'Apt 103 Skyline', projIndex: 1, price: 8500000, area: 1300, type: 'APARTMENT' },
    { code: 'PROP-SK-201', title: 'Apt 201 Skyline', projIndex: 1, price: 9000000, area: 1400, type: 'APARTMENT' },
    { code: 'PROP-SK-202', title: 'Apt 202 Skyline', projIndex: 1, price: 9200000, area: 1450, type: 'APARTMENT' },
    { code: 'PROP-SK-PH1', title: 'Penthouse Skyline', projIndex: 1, price: 18000000, area: 3000, type: 'PENTHOUSE' },
  ];

  const createdProperties: any[] = [];
  for (const prop of propertyData) {
    const p = await prisma.property.upsert({
      where: { property_code: prop.code },
      update: { price: prop.price },
      create: {
        property_code: prop.code,
        title: prop.title,
        company_id: company.id,
        branch_id: branch.id,
        project_id: createdProjects[prop.projIndex]?.id,
        price: prop.price,
        area_sqft: prop.area,
        category: prop.type,
        location: createdProjects[prop.projIndex]?.location || 'Hyderabad',
        created_by_id: createdEmployees['RRH-EMP-001']?.id || 1,
        status: 'LIVE',
      },
    });
    createdProperties.push(p);
    console.log(`✅ Property upserted: ${prop.code}`);
  }

  // 4. Customers
  const customerData = [
    { code: 'CUST-DEV-01', fname: 'John', lname: 'Doe', phone: '9998887701' },
    { code: 'CUST-DEV-02', fname: 'Jane', lname: 'Smith', phone: '9998887702' },
    { code: 'CUST-DEV-03', fname: 'Rahul', lname: 'Kumar', phone: '9998887703' },
    { code: 'CUST-DEV-04', fname: 'Priya', lname: 'Sharma', phone: '9998887704' },
    { code: 'CUST-DEV-05', fname: 'Vikram', lname: 'Singh', phone: '9998887705' },
    { code: 'CUST-DEV-06', fname: 'Anita', lname: 'Desai', phone: '9998887706' },
    { code: 'CUST-DEV-07', fname: 'Suresh', lname: 'Reddy', phone: '9998887707' },
    { code: 'CUST-DEV-08', fname: 'Lakshmi', lname: 'Narayan', phone: '9998887708' },
    { code: 'CUST-DEV-09', fname: 'Kiran', lname: 'Rao', phone: '9998887709' },
    { code: 'CUST-DEV-10', fname: 'Deepa', lname: 'Menon', phone: '9998887710' },
  ];

  const createdCustomers: any[] = [];
  for (const cust of customerData) {
    const c = await prisma.customer.upsert({
      where: { customer_code: cust.code },
      update: {},
      create: {
        customer_code: cust.code,
        company_id: company.id,
        first_name: cust.fname,
        last_name: cust.lname,
        phone: cust.phone,
      },
    });
    createdCustomers.push(c);
    console.log(`✅ Customer upserted: ${cust.code}`);
  }

  // 5. Leads
  const leadData = [];
  for (let i = 1; i <= 15; i++) {
    const statusIdx = i % 5;
    const statuses = ['NEW', 'CONTACTED', 'QUALIFIED', 'SITE_VISIT_SCHEDULED', 'NEGOTIATION'];
    leadData.push({
      code: `LEAD-DEV-${i.toString().padStart(2, '0')}`,
      name: `Lead ${i}`,
      phone: `99988866${i.toString().padStart(2, '0')}`,
      status: statuses[statusIdx],
      projIndex: i % 2,
    });
  }

  const createdLeads: any[] = [];
  for (const ld of leadData) {
    const l = await prisma.lead.upsert({
      where: { lead_code: ld.code },
      update: { status: ld.status },
      create: {
        lead_code: ld.code,
        company_id: company.id,
        customer_name: ld.name,
        phone: ld.phone,
        status: ld.status,
        project_id: createdProjects[ld.projIndex]?.id,
        assigned_to_id: createdEmployees['RRH-EMP-003']?.id,
      },
      select: { id: true, lead_code: true }
    });
    createdLeads.push(l);
    console.log(`✅ Lead upserted: ${ld.code}`);
  }

  // 6. Site Visits
  const svData = [
    { code: 'SV-DEV-01', leadIdx: 0, status: 'SCHEDULED' },
    { code: 'SV-DEV-02', leadIdx: 1, status: 'COMPLETED' },
    { code: 'SV-DEV-03', leadIdx: 2, status: 'CANCELLED' },
    { code: 'SV-DEV-04', leadIdx: 3, status: 'COMPLETED' },
    { code: 'SV-DEV-05', leadIdx: 4, status: 'SCHEDULED' },
    { code: 'SV-DEV-06', leadIdx: 5, status: 'COMPLETED' },
  ];

  for (const sv of svData) {
    await prisma.siteVisitBooking.upsert({
      where: { booking_code: sv.code },
      update: { status: sv.status },
      create: {
        booking_code: sv.code,
        lead_id: createdLeads[sv.leadIdx].id,
        telecaller_id: createdEmployees['RRH-EMP-003']?.id || 1,
        scheduled_date: new Date(Date.now() + 86400000), // Tomorrow
        status: sv.status,
      },
    });
    console.log(`✅ Site Visit upserted: ${sv.code}`);
  }

  // 7. Bookings
  const bkData = [
    { code: 'BKG-DEV-01', custIdx: 0, propIdx: 0, status: 'PENDING', amount: 100000 },
    { code: 'BKG-DEV-02', custIdx: 1, propIdx: 1, status: 'CONFIRMED', amount: 500000 },
    { code: 'BKG-DEV-03', custIdx: 2, propIdx: 5, status: 'REGISTERED', amount: 1000000 },
    { code: 'BKG-DEV-04', custIdx: 3, propIdx: 6, status: 'CANCELLED', amount: 100000 },
  ];

  const createdBookings: any[] = [];
  for (const bk of bkData) {
    const b = await prisma.booking.upsert({
      where: { booking_code: bk.code },
      update: { status: bk.status },
      create: {
        booking_code: bk.code,
        company_id: company.id,
        customer_id: createdCustomers[bk.custIdx].id,
        property_id: createdProperties[bk.propIdx].id,
        status: bk.status,
        agreed_price: createdProperties[bk.propIdx].price,
        booking_amount: bk.amount,
        balance_amount: createdProperties[bk.propIdx].price - bk.amount,
      },
    });
    createdBookings.push(b);
    console.log(`✅ Booking upserted: ${bk.code}`);
  }

  // 8. Complaints
  const cmpData = [
    { code: 'CMP-DEV-01', custIdx: 0, bkgIdx: 0, status: 'OPEN', title: 'Payment Issue' },
    { code: 'CMP-DEV-02', custIdx: 1, bkgIdx: 1, status: 'IN_PROGRESS', title: 'Process Delay' },
    { code: 'CMP-DEV-03', custIdx: 2, bkgIdx: 2, status: 'RESOLVED', title: 'Address Correction' },
    { code: 'CMP-DEV-04', custIdx: 1, bkgIdx: 1, status: 'CLOSED', title: 'General Inquiry' },
    { code: 'CMP-DEV-05', custIdx: 3, bkgIdx: 3, status: 'OPEN', title: 'Refund Status' },
  ];

  for (const cmp of cmpData) {
    await prisma.complaint.upsert({
      where: { complaint_code: cmp.code },
      update: { status: cmp.status },
      create: {
        complaint_code: cmp.code,
        company_id: company.id,
        customer_id: createdCustomers[cmp.custIdx].id,
        booking_id: createdBookings[cmp.bkgIdx]?.id,
        title: cmp.title,
        status: cmp.status,
        priority: 'MEDIUM',
      },
    });
    console.log(`✅ Complaint upserted: ${cmp.code}`);
  }

  // 9. Notifications (Customer Notification)
  const notifData = [
    { custIdx: 0, title: 'Welcome to RRH', message: 'Your account is created', is_read: false },
    { custIdx: 1, title: 'Booking Confirmed', message: 'Your booking BKG-DEV-02 is confirmed', is_read: true },
    { custIdx: 2, title: 'Registration Due', message: 'Please complete registration', is_read: false },
    { custIdx: 0, title: 'Payment Received', message: 'Token amount received', is_read: true },
    { custIdx: 3, title: 'Booking Cancelled', message: 'Your booking was cancelled', is_read: true },
    { custIdx: 4, title: 'Site Visit Reminder', message: 'Site visit tomorrow', is_read: false },
    { custIdx: 5, title: 'New Project Launch', message: 'Check out our new project', is_read: false },
    { custIdx: 6, title: 'KYC Verification Required', message: 'Please upload KYC documents', is_read: false },
  ];

  // We can't upsert without a unique field on notifications. We will just delete development notifications and recreate them to stay idempotent.
  await prisma.customerNotification.deleteMany({
    where: { title: { in: notifData.map(n => n.title) } }
  });

  for (const notif of notifData) {
    await prisma.customerNotification.create({
      data: {
        company_id: company.id,
        customer_id: createdCustomers[notif.custIdx].id,
        title: notif.title,
        message: notif.message,
        is_read: notif.is_read,
        type: 'SYSTEM',
      }
    });
  }
  console.log(`✅ ${notifData.length} Notifications recreated.`);

  console.log('✅ Development dataset seeded successfully.');
}
