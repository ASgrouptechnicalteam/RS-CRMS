// Diagnostic helper to verify Document removal status
// Run: node prisma/diagnostic_check.ts
// This file checks that Document tables no longer exist in the database
const { PrismaClient } = require('@prisma/client');

async function check() {
  const prisma = new PrismaClient();
  console.log('=== Document Removal Verification ===');
  const tables = await prisma.$queryRaw`SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA='test_db' AND (TABLE_NAME LIKE '%document%' OR TABLE_NAME LIKE '%signature%')`;
  if (tables.length === 0) {
    console.log('✅ PASS: No Document or Signature tables found in test_db');
  } else {
    console.log('❌ FAIL: Found tables:', tables.map(t => t.TABLE_NAME).join(', '));
  }
  await prisma.$disconnect();
}

check().catch(e => { console.error(e.message); process.exit(1); });
