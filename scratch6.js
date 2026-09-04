const { PrismaClient } = require('@prisma/client');
const { Roles } = require('./dist/shared/index.js');
const { buildLeadScope } = require('./dist/authz/dataScope.js');

const prisma = new PrismaClient();

async function test() {
  const adminUser = {
    employeeId: 1,
    companyId: 1,
    roles: [Roles.ADMIN],
    permissions: []
  };
  
  const scope = await buildLeadScope(adminUser);
  console.log('Admin Scope:', JSON.stringify(scope));
  
  const leads = await prisma.lead.count({ where: scope });
  console.log('Admin Leads Count:', leads);
  
  const mdUser = {
    employeeId: 1,
    companyId: 1,
    roles: [Roles.MD],
    permissions: []
  };
  
  const mdScope = await buildLeadScope(mdUser);
  console.log('MD Scope:', JSON.stringify(mdScope));
  
  const mdLeads = await prisma.lead.count({ where: mdScope });
  console.log('MD Leads Count:', mdLeads);
}

test().catch(console.error).finally(() => prisma.$disconnect());
