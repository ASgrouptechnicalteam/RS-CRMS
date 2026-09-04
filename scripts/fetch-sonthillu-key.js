const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async function() {
  try {
    const company = await prisma.company.findUnique({ where: { code: 'SONTHILLU' } });
    if (!company) {
      console.log('NO_COMPANY');
      return;
    }
    console.log('COMPANY_ID=' + company.id);

    const keys = await prisma.publicApiKey.findMany({
      where: { company_id: company.id, is_active: true },
      select: { api_key: true }
    });

    if (keys.length === 0) {
      console.log('NO_KEYS');
      return;
    }

    console.log('API_KEY=' + keys[0].api_key);
  } catch (e) {
    console.log('ERROR=' + e.message);
  } finally {
    prisma.$disconnect();
  }
})();
