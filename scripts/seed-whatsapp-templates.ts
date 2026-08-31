import { PrismaClient } from '@prisma/client';
import { MessageTemplateKey } from '@rrh-ems/shared';

const prisma = new PrismaClient();

const defaultTemplates = [
  {
    template_key: MessageTemplateKey.LEAD_PROPERTY_PROPOSAL,
    name: 'Lead Property Proposal',
    body_text: `🏡 *EXCLUSIVE PROPERTY PROPOSAL*

Dear *{customer_name}*,

We found a premium property matching your requirements!

📌 *Title*: {property_name} ({property_code})
📍 *Location*: {property_location}
💰 *Asking Price*: {property_price}

Contact {pm_name} / {agent_name} to schedule a site visit.
Ref: {lead_code}`,
    is_active: true,
  },
  {
    template_key: MessageTemplateKey.DEMO_SCHEDULED,
    name: 'Demo Scheduled Confirmation',
    body_text: `Dear {customer_name}, your demo is scheduled for {visit_date} at {visit_time}. Please be available.`,
    is_active: true,
  },
  {
    template_key: MessageTemplateKey.SITE_VISIT_SCHEDULED,
    name: 'Site Visit Scheduled',
    body_text: `Dear {customer_name}, your site visit for {property_name} is confirmed for {visit_date} at {visit_time}.`,
    is_active: true,
  },
  {
    template_key: MessageTemplateKey.SITE_VISIT_ACCEPTED,
    name: 'Site Visit Accepted',
    body_text: `Dear {customer_name}, your site visit for {property_name} is confirmed for {visit_date} at {visit_time}.`,
    is_active: true,
  },
  {
    template_key: MessageTemplateKey.DAY_BEFORE_RECONFIRMATION,
    name: 'Day Before Reconfirmation',
    body_text: `Dear {customer_name}, confirming your visit to {property_name} tomorrow at {visit_time}. Your project manager is {pm_name}.`,
    is_active: true,
  },
  {
    template_key: MessageTemplateKey.RESCHEDULE_CONFIRMED,
    name: 'Reschedule Confirmed',
    body_text: `Dear {customer_name}, your site visit has been rescheduled to {visit_date} at {visit_time}.`,
    is_active: true,
  },
  {
    template_key: MessageTemplateKey.POST_VISIT_INTERESTED,
    name: 'Post Visit Interested',
    body_text: `Thank you {customer_name} for visiting {property_name}. {pm_name} will be in touch with you shortly.`,
    is_active: true,
  },
  {
    template_key: MessageTemplateKey.BOOKING_CONFIRMED,
    name: 'Booking Confirmed',
    body_text: `Congratulations {customer_name}! Your booking {booking_code} for {property_name} is confirmed. Welcome to {company_name}.`,
    is_active: true,
  },
];

async function seed() {
  console.log('Seeding WhatsApp Templates...');
  for (const template of defaultTemplates) {
    const existing = await prisma.messageTemplate.findFirst({
      where: { template_key: template.template_key }
    });

    if (!existing) {
      await prisma.messageTemplate.create({
        data: template
      });
      console.log(`Created template: ${template.template_key}`);
    } else {
      console.log(`Skipped existing template: ${template.template_key}`);
    }
  }
  console.log('Done.');
}

seed()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
