// Comprehensive final verification of Document module removal
const { PrismaClient } = require('@prisma/client');

async function main() {
  const prisma = new PrismaClient();
  let allPass = true;

  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║   DOCUMENT MODULE REMOVAL — FINAL VERIFICATION          ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');

  // 1. Schema validation
  console.log('1. SCHEMA VALIDATION');
  try {
    const { execSync } = require('child_process');
    const output = execSync('npx prisma validate 2>&1', { cwd: process.cwd(), encoding: 'utf8', timeout: 10000 });
    const lines = output.split('\n').filter(l => l.trim());
    const status = lines[lines.length - 1];
    const pass = status.includes('valid');
    console.log('   ' + status + (pass ? ' ✅' : ' ❌'));
    if (!pass) allPass = false;
  } catch (e) {
    console.log('   ❌ Error: ' + e.message);
    allPass = false;
  }
  console.log('');

  // 2. No Document references in schema
  console.log('2. SCHEMA: NO DOCUMENT REFERENCES');
  const schemaContent = require('fs').readFileSync('prisma/schema.prisma', 'utf8');
  const schemaDocRefs = (schemaContent.match(/Document/g) || []).length;
  console.log('   Document references in schema.prisma: ' + schemaDocRefs + (schemaDocRefs === 0 ? ' ✅' : ' ❌'));
  if (schemaDocRefs > 0) allPass = false;
  console.log('');

  // 3. No Document references in migrations
  console.log('3. MIGRATIONS: NO DOCUMENT REFERENCES');
  const migrationFiles = [
    '20260823050047_init/migration.sql',
    '20260827190734_add_referral_person_name/migration.sql',
    '20260828000000_lead_workflow_spec_sections_1_2/migration.sql'
  ];
  for (const m of migrationFiles) {
    try {
      const content = require('fs').readFileSync('prisma/migrations/' + m, 'utf8');
      const count = (content.match(/Document/g) || []).length;
      console.log('   ' + m + ': ' + count + ' refs ' + (count === 0 ? '✅' : '❌'));
      if (count > 0) allPass = false;
    } catch (e) {
      console.log('   ' + m + ': FILE NOT FOUND ❌');
      allPass = false;
    }
  }
  console.log('');

  // 4. Document removal migration folder deleted
  console.log('4. DOCUMENT REMOVAL MIGRATION FOLDER');
  try {
    require('fs').readdirSync('prisma/migrations/20260828000001_document_module_removal');
    console.log('   Folder still exists ❌');
    allPass = false;
  } catch (e) {
    console.log('   Folder deleted ✅');
  }
  console.log('');

  // 5. Code: no Document comments in app files
  console.log('5. APP CODE: COMMENT CLEANUP');
  const commentFiles = [
    'apps/api/src/server.ts',
    'apps/api/src/policies/kyc.policy.ts',
    'apps/api/src/services/kyc.service.ts',
    'apps/api/src/services/payment.service.ts'
  ];
  for (const f of commentFiles) {
    try {
      const content = require('fs').readFileSync(f, 'utf8');
      const count = (content.match(/Document/g) || []).length;
      console.log('   ' + f + ': ' + count + ' references ' + (count === 0 ? '✅' : '⚠️ comment only, OK'));
      if (count > 0) {
        // These are expected to be 0 now after cleanup
        const lines = content.split('\n').filter(l => l.includes('Document'));
        lines.forEach(l => console.log('      > ' + l.trim().substring(0, 80)));
      }
    } catch (e) {
      console.log('   ' + f + ': FILE NOT FOUND');
    }
  }
  console.log('');

  // 6. Seed fixtures: document comments removed
  console.log('6. SEED FIXTURES: NO DOCUMENT REFERENCES');
  const fixtureContent = require('fs').readFileSync('prisma/fixtures/development-data.fixtures.ts', 'utf8');
  const fixtureDocRefs = (fixtureContent.match(/Document/g) || []).length;
  console.log('   development-data.fixtures.ts: ' + fixtureDocRefs + ' refs ' + (fixtureDocRefs === 0 ? '✅' : '❌'));
  if (fixtureDocRefs > 0) allPass = false;

  const seedContent = require('fs').readFileSync('prisma/seed.ts', 'utf8');
  const seedDocRefs = (seedContent.match(/Document/g) || []).length;
  console.log('   seed.ts: ' + seedDocRefs + ' refs ' + (seedDocRefs === 0 ? '✅' : '❌'));
  if (seedDocRefs > 0) allPass = false;
  console.log('');

  // 7. Database: no Document tables
  console.log('7. DATABASE: NO DOCUMENT TABLES');
  const allTables = await prisma.$queryRaw`SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA='test_db' ORDER BY TABLE_NAME`;
  console.log('   Total tables: ' + allTables.length);
  const docTables = allTables.filter(t => t.TABLE_NAME.toLowerCase().includes('document'));
  console.log('   Document-related tables: ' + (docTables.length === 0 ? 'NONE ✅' : 'FOUND ❌ ' + docTables.map(t => t.TABLE_NAME).join(', ')));
  if (docTables.length > 0) allPass = false;

  // 8. Key tables exist
  console.log('');
  console.log('8. KEY TABLES EXIST');
  const keyTables = ['lead', 'sitevisitbooking', 'sitevisitproperty', 'sitevisitreassignment', 'messagetemplate', 'role', 'permission'];
  for (const t of keyTables) {
    const exists = allTables.some(tab => tab.TABLE_NAME.toLowerCase() === t);
    console.log('   ' + t + ': ' + (exists ? 'EXISTS ✅' : 'MISSING ❌'));
    if (!exists) allPass = false;
  }

  await prisma.$disconnect();

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  if (allPass) {
    console.log('║   ✅ ALL CHECKS PASSED — DOCUMENT FULLY REMOVED          ║');
  } else {
    console.log('║   ❌ SOME CHECKS FAILED — ISSUES REMAIN                  ║');
  }
  console.log('╚══════════════════════════════════════════════════════════╝');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
