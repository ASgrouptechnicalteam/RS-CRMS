import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

async function main() {
  const crmDb = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL_PRODUCTION });

  try {
    const sqlFilePath = path.join(__dirname, '../../../docs/u988844918_RS_DB.sql');
    const sqlContent = fs.readFileSync(sqlFilePath, 'utf8');

    console.log('Extracting and executing INSERT statements for DailyReport...');

    const regex = new RegExp(`INSERT INTO \\\`DailyReport\\\`[\\s\\S]*?;`, 'g');
    const matches = sqlContent.match(regex);

    if (matches) {
      for (const match of matches) {
        const safeInsert = match.replace(/^INSERT INTO/i, 'INSERT IGNORE INTO');
        await crmDb.$executeRawUnsafe(safeInsert);
      }
      console.log(`✅ Successfully imported DailyReport`);
    } else {
      console.log(`⚠️ No INSERT statements found for DailyReport`);
    }

    const count = await crmDb.dailyReport.count();
    console.log(`Total Daily Reports in CRM_API now: ${count}`);
  } catch (err) {
    console.error('Import failed:', err);
  } finally {
    await crmDb.$disconnect();
  }
}

main();
