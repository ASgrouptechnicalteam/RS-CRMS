"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
const prisma = new client_1.PrismaClient();
async function main() {
    console.log('Inspecting DailyTargets...');
    const targets = await prisma.dailyTarget.findMany({
        include: {
            employee: {
                select: {
                    company_id: true,
                    employee_code: true
                }
            }
        }
    });
    console.log(`Total Targets: ${targets.length}`);
    targets.forEach(t => {
        console.log(`- Target ID: ${t.id} | Role: ${t.role_name} | Employee ID: ${t.employee_id} | Company ID (via employee): ${t.employee?.company_id}`);
    });
    const allCompanies = await prisma.company.findMany();
    console.log('Active Companies:');
    console.log(allCompanies.map(c => `[ID: ${c.id}] ${c.name}`).join('\n'));
}
main()
    .catch(e => console.error(e))
    .finally(() => prisma.$disconnect());
