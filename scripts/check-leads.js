const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async function() {
  try {
    const count = await prisma.lead.count({ where: { company_id: 17 } });
    console.log('Sonthillu lead count:', count);

    const leads = await prisma.lead.findMany({
      where: { company_id: 17 },
      orderBy: { id: 'desc' },
      take: 15,
      select: {
        id: true,
        lead_code: true,
        enquiry_type: true,
        source: true,
        status: true,
        customer_name: true,
        phone: true,
        email: true,
        utm_source: true,
        utm_medium: true,
        utm_campaign: true,
        notes: true,
        created_at: true
      }
    });

    console.log('\nRecent Sonthillu leads (last 15):');
    leads.forEach(l => {
      console.log(
        'ID:' + l.id +
        ' | Code:' + (l.lead_code || 'N/A') +
        ' | Type:' + (l.enquiry_type || 'N/A') +
        ' | Src:' + (l.source || 'N/A') +
        ' | Status:' + (l.status || 'N/A') +
        ' | Name:' + (l.customer_name || 'N/A') +
        ' | Phone:' + (l.phone || 'N/A') +
        ' | UTM:' + (l.utm_source || '-') + '/' + (l.utm_medium || '-') + '/' + (l.utm_campaign || '-')
      );
    });

    console.log('\nTotal leads in CRM (all companies):', await prisma.lead.count());
  } catch (e) {
    console.log('ERROR:', e.message);
  } finally {
    prisma.$disconnect();
  }
})();
