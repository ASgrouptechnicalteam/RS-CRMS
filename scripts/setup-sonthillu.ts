import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  let company = await prisma.company.findUnique({ where: { code: 'SONTHILLU' } });
  
  if (!company) {
    console.log('Sonthillu company not found. Creating...');
    company = await prisma.company.create({
      data: {
        code: 'SONTHILLU',
        name: 'Sonthillu Constructions',
        property_type_group: 'SONTHILLU'
      }
    });
    console.log('Created company:', company.id);
  } else {
    console.log('Company found:', company.id);
  }

  const crypto = require('crypto');
  let apiKeyRecord = await prisma.publicApiKey.findFirst({
    where: { company_id: company.id, is_active: true }
  });

  if (!apiKeyRecord) {
    console.log('No active API key found. Creating...');
    const apiKey = 'sk_pro_llu_' + crypto.randomBytes(16).toString('hex');
    apiKeyRecord = await prisma.publicApiKey.create({
      data: {
        api_key: apiKey,
        company_id: company.id,
        is_active: true,
        
      },
    });
    console.log('Created API Key:', apiKey);
  } else {
    console.log('Active API Key found:', apiKeyRecord.api_key);
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
