import { PrismaClient } from '@prisma/client';
import { generateToken } from './src/utils/jwt';
import axios from 'axios';

const prisma = new PrismaClient();

async function runTests() {
  console.log('--- Starting Scrutiny Tests ---');
  let company, employee, customer, property, booking, payment;
  try {
    // 1. Setup Test Data
    company = await prisma.company.create({ data: { name: 'Test Co' } });
    employee = await prisma.employee.create({
      data: {
        company_id: company.id,
        first_name: 'Test',
        last_name: 'User',
        email: 'test@payment.com',
        password_hash: 'hash',
        role: 'ADMIN',
        status: 'ACTIVE'
      }
    });
    customer = await prisma.customer.create({
      data: {
        company_id: company.id,
        first_name: 'Cust',
        last_name: 'Test',
        email: 'cust@test.com',
        phone: '1234567890'
      }
    });
    property = await prisma.property.create({
      data: {
        company_id: company.id,
        title: 'Test Prop',
        type: 'PLOT',
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
        booking_code: 'BK-TEST-1',
        agreed_price: 1000000,
        booking_amount: 100000,
        balance_amount: 900000,
        status: 'CONFIRMED'
      }
    });

    const token = generateToken({
      employeeId: employee.id,
      companyId: company.id,
      role: employee.role,
      email: employee.email
    });

    const api = axios.create({
      baseURL: 'http://localhost:3000/api/v1',
      headers: { Authorization: `Bearer ${token}` },
      validateStatus: () => true
    });

    // Test 1: Negative Amount
    console.log('\n[Test 1] Negative Amount (-500)');
    let res = await api.post('/payments', {
      booking_id: booking.id,
      amount: -500,
      payment_method: 'ONLINE',
      reference_number: 'REF-NEG'
    });
    console.log('Status:', res.status);
    console.log('Response:', JSON.stringify(res.data, null, 2));

    // Test 2: Non-cent precision (100.555)
    console.log('\n[Test 2] Non-cent precision (100.555)');
    res = await api.post('/payments', {
      booking_id: booking.id,
      amount: 100.555,
      payment_method: 'ONLINE',
      reference_number: 'REF-PREC'
    });
    console.log('Status:', res.status);
    console.log('Response:', JSON.stringify(res.data, null, 2));

    // Test 3: Duplicate transaction_ref
    console.log('\n[Test 3a] Insert valid payment (REF-DUP)');
    res = await api.post('/payments', {
      booking_id: booking.id,
      amount: 1000,
      payment_method: 'ONLINE',
      reference_number: 'REF-DUP'
    });
    console.log('Status:', res.status);
    console.log('Response:', JSON.stringify(res.data, null, 2));

    console.log('\n[Test 3b] Insert duplicate (REF-DUP)');
    res = await api.post('/payments', {
      booking_id: booking.id,
      amount: 2000,
      payment_method: 'ONLINE',
      reference_number: 'REF-DUP'
    });
    console.log('Status:', res.status);
    console.log('Response:', JSON.stringify(res.data, null, 2));

  } catch (err) {
    console.error('Test script error:', err);
  } finally {
    // Cleanup
    if (booking) await prisma.payment.deleteMany({ where: { booking_id: booking.id } }).catch(()=>{});
    if (booking) await prisma.booking.delete({ where: { id: booking.id } }).catch(()=>{});
    if (property) await prisma.property.delete({ where: { id: property.id } }).catch(()=>{});
    if (customer) await prisma.customer.delete({ where: { id: customer.id } }).catch(()=>{});
    if (employee) await prisma.employee.delete({ where: { id: employee.id } }).catch(()=>{});
    if (company) await prisma.company.delete({ where: { id: company.id } }).catch(()=>{});
    await prisma.$disconnect();
  }
}

runTests();
