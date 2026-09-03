const { PrismaClient } = require('@prisma/client');
const jwt = require('jsonwebtoken');

const prisma = new PrismaClient();

async function runTests() {
  console.log('--- Starting Scrutiny Tests ---');
  let company, employee, customer, property, booking;
  try {
    company = await prisma.company.create({ data: { name: 'Test Co ' + Date.now(), code: 'TC-' + Date.now() } });
    employee = await prisma.employee.create({
      data: {
        company_id: company.id,
        employee_code: 'EMP-' + Date.now(),
        full_name: 'Test User',
        email: 'test' + Date.now() + '@payment.com',
        password_hash: 'hash',
        status: 'ACTIVE'
      }
    });
    customer = await prisma.customer.create({
      data: {
        company_id: company.id,
        customer_code: 'CUST-' + Date.now(),
        first_name: 'Cust',
        last_name: 'Test',
        email: 'cust' + Date.now() + '@test.com',
        phone: '1234567890'
      }
    });
    property = await prisma.property.create({
      data: {
        company_id: company.id,
        property_code: 'P-' + Date.now(),
        title: 'Test Prop',
        category: 'PLOT',
        brand_type: 'RRH',
        source: 'DIRECT',
        location: 'Test Loc',
        status: 'LIVE',
        price: 1000000,
        area_sqft: 1000
      }
    });
    booking = await prisma.booking.create({
      data: {
        company_id: company.id,
        customer_id: customer.id,
        property_id: property.id,
        assigned_employee_id: employee.id,
        booking_code: 'BK-TEST-' + Date.now(),
        agreed_price: 1000000,
        booking_amount: 100000,
        balance_amount: 900000,
        status: 'CONFIRMED'
      }
    });

    const token = jwt.sign({
      employeeId: employee.id,
      employeeCode: employee.employee_code,
      companyId: company.id,
      branchId: null,
      roles: ['ADMIN', 'MD', 'FINANCE'],
      permissions: ['payments.create'],
      tokenVersion: 1
    }, 'a81241ca7b9a06771dd442b2157fabeb632503b582a11a39929a0b53ff7b327e', { expiresIn: '24h' });

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    };

    const makeRequest = async (body) => {
      const res = await fetch('http://localhost:3000/api/v1/payments', {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
      });
      const data = await res.json();
      return { status: res.status, data };
    };

    console.log('\n[Test 1] Negative Amount (-500)');
    let res = await makeRequest({
      booking_id: booking.id,
      amount: -500,
      payment_method: 'ONLINE',
      reference_number: 'REF-NEG-' + Date.now()
    });
    console.log('Status:', res.status);
    console.log('Response:', JSON.stringify(res.data, null, 2));

    console.log('\n[Test 2] Non-cent precision (100.555)');
    res = await makeRequest({
      booking_id: booking.id,
      amount: 100.555,
      payment_method: 'ONLINE',
      reference_number: 'REF-PREC-' + Date.now()
    });
    console.log('Status:', res.status);
    console.log('Response:', JSON.stringify(res.data, null, 2));

    const ref = 'REF-DUP-' + Date.now();
    console.log('\n[Test 3a] Insert valid payment (' + ref + ')');
    res = await makeRequest({
      booking_id: booking.id,
      amount: 1000,
      payment_method: 'ONLINE',
      reference_number: ref
    });
    console.log('Status:', res.status);
    console.log('Response:', JSON.stringify(res.data, null, 2));

    console.log('\n[Test 3b] Insert duplicate (' + ref + ')');
    res = await makeRequest({
      booking_id: booking.id,
      amount: 2000,
      payment_method: 'ONLINE',
      reference_number: ref
    });
    console.log('Status:', res.status);
    console.log('Response:', JSON.stringify(res.data, null, 2));

  } catch (err) {
    console.error('Test script error:', err);
  } finally {
    if (booking) await prisma.payment.deleteMany({ where: { booking_id: booking.id } }).catch(()=>{});
    if (booking) await prisma.booking.delete({ where: { id: booking.id } }).catch(()=>{});
    if (property) await prisma.property.delete({ where: { id: property.id } }).catch(()=>{});
    if (customer) await prisma.customer.delete({ where: { id: customer.id } }).catch(()=>{});
    if (employee) await prisma.employee.delete({ where: { id: employee.id } }).catch(()=>{});
    if (company) await prisma.company.delete({ where: { id: company.id } }).catch(()=>{});
    await prisma.$disconnect();
  }
}

setTimeout(runTests, 2000);
