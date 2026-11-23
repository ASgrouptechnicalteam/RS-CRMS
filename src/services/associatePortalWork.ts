import { prisma } from '../lib/prisma';
import { Roles, RolePermissionsMatrix } from '../shared';
import { TokenPayload } from '../utils/jwt';
import { AppError } from './lead/errors';
import { createLead } from './lead/create';
import { closeAssociateReferral, OPEN_ASSOCIATE_REFERRAL } from './lead/associateReferral';
import { notifyEmployee } from '../utils/notifyEmployee';
import { logger } from '../utils/logger';
import { tenDigits } from './associate.service';

/**
 * What an associate does in their own app (Step 6, 2026-11-23), beyond reading their customers:
 *  - add a customer they bring (it becomes a normal CRM lead, kept by their Channel Partner Manager), and
 *  - work the leads we forward to them ("From RRH"): accept, decline, and say how it is going.
 * Every answer has a fixed, small shape: no internal notes, staff names or deal values.
 */
const p = prisma as any;

const STAGE_LABEL: Record<string, string> = {
  SITE_VISIT_SCHEDULED: 'Site visit planned',
  SITE_VISIT_COMPLETED: 'Site visit done',
  NEGOTIATION: 'In discussion',
  BOOKING_INITIATED: 'Booking in progress',
};
export const ASSOCIATE_PROGRESS: Record<string, string> = {
  CALLED: 'I have called the customer',
  INTERESTED: 'The customer is interested',
  VISIT_PLANNED: 'A site visit is planned',
  NOT_INTERESTED: 'The customer is not interested',
};

type Me = {
  id: number;
  company_id: number;
  full_name: string;
  owner_cpm_id: number | null;
  phone: string;
};

const view = (r: any, lead: any) => {
  const open = OPEN_ASSOCIATE_REFERRAL.includes(r.status);
  return {
    id: r.id,
    status: r.status,
    customer_name: lead?.customer_name ?? '',
    // The associate needs the number to call while it is theirs; once closed it is hidden again.
    customer_phone: open ? (lead?.phone ?? '') : '',
    project: lead?.project?.name ?? null,
    stage: STAGE_LABEL[r.stage_at_referral] || 'In progress',
    brief: r.brief,
    my_progress: r.associate_stage,
    my_note: r.associate_note,
    offered_at: r.offered_at,
    accepted_at: r.accepted_at,
    last_activity_at: r.last_activity_at,
    closed_reason: open ? null : r.closed_reason,
    open,
  };
};

export async function referredToMe(a: Me) {
  const rows = await p.associateReferral.findMany({
    where: { associate_id: a.id },
    orderBy: [{ open_lead_id: 'desc' }, { id: 'desc' }],
    take: 50,
  });
  const leads = rows.length
    ? await p.lead.findMany({
        where: { id: { in: rows.map((r: any) => r.lead_id) } },
        select: { id: true, customer_name: true, phone: true, project: { select: { name: true } } },
      })
    : [];
  const by = new Map<number, any>(leads.map((l: any) => [l.id, l]));
  return {
    referred: rows.map((r: any) => view(r, by.get(r.lead_id))),
    waiting: rows.filter((r: any) => r.status === 'OFFERED').length,
  };
}

async function mine(a: Me, id: number) {
  const r = await p.associateReferral.findFirst({ where: { id, associate_id: a.id } });
  if (!r) throw new AppError(404, 'Not found');
  return r;
}

/** Tell the person who forwarded it, and the associate's manager. Never breaks the associate's action. */
async function tell(r: any, a: Me, title: string, message: string) {
  const ids = new Set<number>([r.referred_by_id]);
  if (a.owner_cpm_id) ids.add(a.owner_cpm_id);
  for (const id of ids) {
    await notifyEmployee(id, {
      type: 'ASSOCIATE_REFERRAL_UPDATE',
      title,
      message,
      link: `/leads/${r.lead_id}`,
    }).catch((e) => logger.error('[associateReferral] notify failed:', e));
  }
}
const customerOf = async (leadId: number) =>
  (await p.lead.findUnique({ where: { id: leadId }, select: { customer_name: true } }))
    ?.customer_name || 'A customer';

export async function acceptReferral(a: Me, id: number) {
  const r = await mine(a, id);
  if (r.status !== 'OFFERED') throw new AppError(409, 'This customer was already answered');
  const now = new Date();
  await p.associateReferral.update({
    where: { id },
    data: { status: 'ACCEPTED', accepted_at: now, last_activity_at: now },
  });
  await p.leadActivity.create({
    data: {
      lead_id: r.lead_id,
      actor_id: r.referred_by_id,
      activity_type: 'ASSOCIATE_ACCEPTED',
      notes: `${a.full_name} accepted the lead.`,
    },
  });
  await tell(
    r,
    a,
    'An associate took the customer',
    `${a.full_name} accepted ${await customerOf(r.lead_id)}.`,
  );
  return { ok: true };
}

export async function declineReferral(a: Me, id: number, reason: string) {
  const why = (reason || '').trim();
  if (why.length < 3) throw new AppError(400, 'Say why you cannot take this customer');
  const r = await mine(a, id);
  if (!OPEN_ASSOCIATE_REFERRAL.includes(r.status))
    throw new AppError(409, 'This customer is already closed');
  await closeAssociateReferral(id, 'DECLINED', why);
  await p.leadActivity.create({
    data: {
      lead_id: r.lead_id,
      actor_id: r.referred_by_id,
      activity_type: 'ASSOCIATE_DECLINED',
      notes: `${a.full_name} could not take the lead. Reason: ${why}`,
    },
  });
  await tell(
    r,
    a,
    'An associate could not take the customer',
    `${a.full_name} declined ${await customerOf(r.lead_id)}: ${why}. It is back in your list.`,
  );
  return { ok: true };
}

export async function updateReferral(
  a: Me,
  id: number,
  input: { progress: string; note?: string },
) {
  if (!ASSOCIATE_PROGRESS[input.progress]) throw new AppError(400, 'Choose how it is going');
  const r = await mine(a, id);
  if (!OPEN_ASSOCIATE_REFERRAL.includes(r.status))
    throw new AppError(409, 'This customer is already closed');
  const now = new Date();
  const note = (input.note || '').trim().slice(0, 500) || null;
  await p.associateReferral.update({
    where: { id },
    data: {
      // Saying how it is going also means they took it.
      status: 'ACCEPTED',
      accepted_at: r.accepted_at ?? now,
      associate_stage: input.progress,
      associate_note: note,
      last_activity_at: now,
    },
  });
  await p.leadActivity.create({
    data: {
      lead_id: r.lead_id,
      actor_id: r.referred_by_id,
      activity_type: 'ASSOCIATE_UPDATE',
      notes: `${a.full_name}: ${ASSOCIATE_PROGRESS[input.progress]}.${note ? ` ${note}` : ''}`,
    },
  });
  await tell(
    r,
    a,
    'News from an associate',
    `${a.full_name} on ${await customerOf(r.lead_id)}: ${ASSOCIATE_PROGRESS[input.progress]}.`,
  );
  return { ok: true };
}

/** A synthetic sign-in for the manager the customer goes to, so the normal lead rules apply. */
async function managerFor(a: Me): Promise<TokenPayload> {
  const where = {
    company_id: a.company_id,
    status: 'ACTIVE',
    deleted_at: null,
    roles: { some: { role: { name: Roles.CHANNEL_PARTNER_MANAGER } } },
  };
  // Their own manager; else the manager with the fewest associates, so nobody is flooded.
  const owner = a.owner_cpm_id
    ? await p.employee.findFirst({ where: { ...where, id: a.owner_cpm_id } })
    : null;
  const cpm =
    owner ||
    (await p.employee.findFirst({
      where,
      orderBy: [{ owned_associates: { _count: 'asc' } }, { id: 'asc' }],
    }));
  if (!cpm) throw new AppError(409, 'Please ask your manager to add the customer for you for now.');
  const roles = [Roles.CHANNEL_PARTNER_MANAGER];
  return {
    employeeId: cpm.id,
    employeeCode: cpm.employee_code,
    companyId: cpm.company_id,
    branchId: cpm.branch_id ?? null,
    roles,
    permissions: [...new Set(roles.flatMap((r) => (RolePermissionsMatrix as any)[r] || []))],
  } as TokenPayload;
}

export async function addCustomer(
  a: Me,
  input: { customer_name: string; phone: string; project_id?: number | null; note?: string },
) {
  const phone = tenDigits(input.phone);
  if (!/^\d{10}$/.test(phone))
    throw new AppError(400, 'Enter the customer’s 10-digit mobile number');
  const name = (input.customer_name || '').trim();
  if (name.length < 2) throw new AppError(400, 'Enter the customer’s name');
  const manager = await managerFor(a);
  const startedAt = new Date();
  const alreadyHave = {
    added: false,
    message:
      'We already have this customer. Our team is working on them, so there is nothing more to do.',
  };
  let res: any;
  try {
    res = await createLead(manager, {
      customer_name: name,
      phone,
      source: 'ASSOCIATE',
      ownership_type: 'DIRECT',
      associate_id: a.id,
      ...(input.note?.trim() ? { notes: input.note.trim().slice(0, 1000) } : {}),
      ...(input.project_id ? { project_id: input.project_id } : {}),
    });
  } catch (e: any) {
    // A customer we had before and dropped: never show their history to the associate.
    if (e?.statusCode === 409) return alreadyHave;
    throw e;
  }
  const lead = res.lead;
  // createLead hands back the existing lead for a number we already have: say so without showing whose.
  if (!lead || lead.created_at < startedAt) return alreadyHave;
  await p.leadActivity.create({
    data: {
      lead_id: lead.id,
      actor_id: manager.employeeId,
      activity_type: 'NOTE_ADDED',
      notes: `Added by ${a.full_name} in the associate app.`,
    },
  });
  await notifyEmployee(manager.employeeId, {
    type: 'ASSOCIATE_NEW_CUSTOMER',
    title: 'A new customer from an associate',
    message: `${a.full_name} added ${name}. Please call them.`,
    link: `/leads/${lead.id}`,
  }).catch((e) => logger.error('[associate app] notify failed:', e));
  return { added: true, message: 'Thank you. Our team will call your customer soon.' };
}
