const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

async function main() {
  const p = new PrismaClient();
  const sql = fs.readFileSync(
    path.join(__dirname, '../../prisma/manual-migrations/2026-09-08_website_accounts.sql'),
    'utf8'
  );
  const statements = sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('--'));

  for (const stmt of statements) {
    console.log('Running:', stmt.slice(0, 80).replace(/\n/g, ' ') + '...');
    await p.$executeRawUnsafe(stmt);
  }
  console.log('Done.');
  await p.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
