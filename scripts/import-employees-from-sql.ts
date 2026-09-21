import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

async function main() {
  const crmUrl = process.env.CRM_DB_URL;

  if (!crmUrl) {
    console.error('Error: CRM_DB_URL environment variable must be provided.');
    console.error('Usage: CRM_DB_URL="..." npx ts-node scripts/import-employees-from-sql.ts');
    process.exit(1);
  }

  const crmDb = new PrismaClient({ datasourceUrl: crmUrl });

  try {
    const sqlFilePath = path.join(__dirname, '../../../docs/u988844918_RS_DB.sql');
    if (!fs.existsSync(sqlFilePath)) {
      console.error(`File not found: ${sqlFilePath}`);
      process.exit(1);
    }
    const sqlContent = fs.readFileSync(sqlFilePath, 'utf8');

    // We only want to extract INSERT statements for specific tables
    const tablesToImport = [
      'Employee',
      'EmployeeRole',
      'EmployeeBranch',
      'EmployeeCompanyAccess',
      'EmployeePermissionOverride',
      'EmployeeQrCode',
      'AttendanceLog',
    ];

    console.log('Extracting and executing INSERT statements from SQL dump...');

    // First, deactivate the existing admin (or all employees) in CRM_API
    await crmDb.$executeRawUnsafe(`UPDATE \`Employee\` SET \`status\` = 'INACTIVE'`);
    console.log('Deactivated existing CRM_API employees.');

    // Split the SQL file into statements
    // This regex carefully matches INSERT INTO `TableName` ... VALUES ... ;
    // across multiple lines
    for (const table of tablesToImport) {
      console.log(`Processing table: ${table}...`);

      const regex = new RegExp(`INSERT INTO \\\`${table}\\\`[\\s\\S]*?;`, 'g');
      const matches = sqlContent.match(regex);

      if (matches) {
        for (const match of matches) {
          // To prevent foreign key errors on REPLACE INTO and prevent duplicates crashing the script,
          // we change INSERT INTO to INSERT IGNORE INTO
          const safeInsert = match.replace(/^INSERT INTO/i, 'INSERT IGNORE INTO');
          await crmDb.$executeRawUnsafe(safeInsert);
        }
        console.log(`✅ Successfully imported ${table}`);
      } else {
        console.log(`⚠️ No INSERT statements found for ${table}`);
      }
    }

    console.log('✅ Import completed successfully!');
  } catch (err) {
    console.error('Import failed:', err);
  } finally {
    await crmDb.$disconnect();
  }
}

main();
