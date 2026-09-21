/**
 * One-off remediation for the specific duplicate found by
 * normalizeEmployeeContacts.ts on 2026-09-14: 4 production employees shared
 * the placeholder email "example@gmail.com":
 *   RRH-OP-3514, RRH-MK-5052, RRH-SL-4126, RRH-SL-4770
 *
 * Clears email to NULL for exactly those 4 (email is optional — see
 * apps/api/src/shared/employee.ts blankAsAbsent). Run this AFTER
 * normalizeEmployeeContacts.ts --apply, then re-run normalizeEmployeeContacts.ts
 * (no --apply) to confirm the duplicate report is empty before adding the
 * UNIQUE(company_id, email) migration.
 *
 * Usage: npx ts-node src/scripts/clearDuplicatePlaceholderEmails.ts
 */
import { prisma } from '../lib/prisma';

const CODES = ['RRH-OP-3514', 'RRH-MK-5052', 'RRH-SL-4126', 'RRH-SL-4770'];
const PLACEHOLDER = 'example@gmail.com';

async function main() {
  const rows = await prisma.employee.findMany({
    where: { employee_code: { in: CODES } },
    select: { id: true, employee_code: true, full_name: true, email: true },
  });
  const notPlaceholder = rows.filter((r) => r.email !== PLACEHOLDER);
  if (notPlaceholder.length > 0) {
    console.error(
      'Aborting: these records no longer hold the expected placeholder email — check manually:',
      JSON.stringify(notPlaceholder),
    );
    process.exitCode = 1;
    return;
  }
  if (rows.length !== CODES.length) {
    console.error(`Aborting: expected ${CODES.length} matching employees, found ${rows.length}.`);
    process.exitCode = 1;
    return;
  }

  for (const r of rows) {
    await prisma.employee.update({ where: { id: r.id }, data: { email: null } });
    console.log(`Cleared email for ${r.employee_code} (${r.full_name})`);
  }
  console.log(`Done — ${rows.length} records updated.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
