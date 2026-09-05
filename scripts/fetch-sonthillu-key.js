const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async function() {
  try {
    const company = await prisma.company.findUnique({ where: { code: 'SONTHILLU' } });
    if (!company) { console.log('NO_COMPANY'); return; }
    console.log('COMPANY_ID=' + company.id);

    const keys = await prisma.publicApiKey.findMany({
      where: { company_id: company.id, is_active: true },
      select: { api_key: true, id: true }
    });

    if (keys.length === 0) { console.log('NO_KEYS'); return; }

    for (const k of keys) {
      console.log('KEY_ID=' + k.id);
      console.log('KEY_LENGTH=' + k.api_key.length);
      console.log('KEY_BYTES=' + Buffer.from(k.api_key, 'utf8').toString('hex'));
      console.log('KEY_VALUE=' + k.api_key);
      console.log('---');
    }
  } catch (e) {
    console.log('ERROR=' + e.message);
  } finally {
    prisma.$disconnect();
  }
})();
