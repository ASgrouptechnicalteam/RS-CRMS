const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
p.role.findMany().then(r => console.log(r)).finally(() => p.$disconnect());
