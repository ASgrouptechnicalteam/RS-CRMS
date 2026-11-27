import { prisma } from '../../lib/prisma';
import { TokenPayload } from '../../utils/jwt';
import { Roles } from '../../shared';
import { buildLeadScope } from '../../authz/dataScope';
import { notifyEmployee } from '../../utils/notifyEmployee';
import { logger } from '../../utils/logger';
import { AppError } from './errors';

const p = prisma;

/**
 * Refer a company lead to an external channel partner (2026-11-23).
 *
 * The lead stays ours: the owner keeps the credit and every record. Referring only
 * (1) opens a CpReferral, the partner's separate "Referred by RRH" inbox, which never
 * mixes with the partner's own private leads, and (2) sets Lead.referred_to_cp_id so the
 * lead leaves our callers' queues and shows "With partner" until it is taken back.
 * No automatic return: if the partner does not respond, the referrer and the MD are
 * told (jobs/reminders.ts) and take it back by hand.
 */

/** Only leads that are far enough along to be worth a partner's time. */
export const REFERRABLE_STATUSES = [
  'SITE_VISIT_SCHEDULED',
  'SITE_VISIT_COMPLETED',
  'NEGOTIATION',
  'BOOKING_INITIATED',
];

export const OPEN_REFERRAL_STATUSES = ['OFFERED', 'ACCEPTED'];

const canManage = (user: TokenPayload) =>
  user.roles.some((r) => [Roles.MD, Roles.ADMIN, Roles.SALES_MANAGER].includes(r as any));

const isMd = (user: TokenPayload) => user.roles.some((r) => r === Roles.MD);

export async function listPartnersForReferral(user: TokenPayload) {
  const partners = await p.employee.findMany({
    where: {
      company_id: user.companyId,
      status: 'ACTIVE',
      deleted_at: null,
      roles: { some: { role: { name: Roles.CHANNEL_PARTNER_EXTERNAL } } },
    },
    select: { id: true, full_name: true, employee_code: true },
    orderBy: { full_name: 'asc' },
  });
  const open = await p.cpReferral.groupBy({
    by: ['cp_id'],
    where: { company_id: user.companyId, status: { in: OPEN_REFERRAL_STATUSES } },
    _count: { _all: true },
  });
  const counts = new Map(open.map((o) => [o.cp_id, o._count._all]));
  return partners.map((x) => ({
    id: x.id,
    name: x.full_name || x.employee_code,
    open_referrals: counts.get(x.id) || 0,
  }));
}

export async function referLead(
  user: TokenPayload,
  leadId: number,
  input: { cp_id: number; brief?: string },
) {
  const scope = await buildLeadScope(user);
  const lead = await p.lead.findFirst({ where: { id: leadId, ...scope } });
  if (!lead) throw new AppError(404, 'Lead not found');

  if (lead.assigned_to_id !== user.employeeId && !canManage(user)) {
    throw new AppError(
      403,
      'Only the person who owns this lead, the MD or a Sales Manager can refer it',
    );
  }
  if (!REFERRABLE_STATUSES.includes(lead.status)) {
    throw new AppError(
      409,
      'A lead can be referred to a channel partner once a site visit is scheduled, or at negotiation or booking in progress',
    );
  }
  if (lead.referred_to_cp_id)
    throw new AppError(409, 'This lead is already with a channel partner');

  const partner = await p.employee.findFirst({
    where: {
      id: input.cp_id,
      company_id: lead.company_id,
      status: 'ACTIVE',
      deleted_at: null,
      roles: { some: { role: { name: Roles.CHANNEL_PARTNER_EXTERNAL } } },
    },
    select: { id: true, full_name: true, employee_code: true },
  });
  if (!partner) throw new AppError(400, 'That channel partner is not active');
  const partnerName = partner.full_name || partner.employee_code;
  const brief = (input.brief || '').trim().slice(0, 1500) || null;

  const referral = await p.$transaction(async (tx) => {
    const r = await tx.cpReferral.create({
      data: {
        company_id: lead.company_id,
        lead_id: lead.id,
        cp_id: partner.id,
        referred_by_id: user.employeeId,
        brief,
        stage_at_referral: lead.status,
        open_lead_id: lead.id,
      },
    });
    await tx.lead.update({ where: { id: lead.id }, data: { referred_to_cp_id: partner.id } });
    await tx.leadActivity.create({
      data: {
        lead_id: lead.id,
        actor_id: user.employeeId,
        activity_type: 'REFERRED_TO_PARTNER',
        notes: `Referred to channel partner ${partnerName} at ${lead.status}.${brief ? ` Brief: ${brief}` : ''}`,
      },
    });
    await tx.auditEvent.create({
      data: {
        actor_id: user.employeeId,
        action: 'LEAD_REFERRED_TO_CP',
        entity_type: 'LEAD',
        entity_id: lead.id,
        new_value: JSON.stringify({ cp_id: partner.id, referral_id: r.id, stage: lead.status }),
      },
    });
    return r;
  });

  // Tell the partner, and the MD when someone other than the MD referred it.
  const note = (employeeId: number, type: string, title: string, message: string, link: string) =>
    notifyEmployee(employeeId, { type, title, message, link }).catch((e) =>
      logger.error('[cpReferral] notify failed:', e),
    );
  await note(
    partner.id,
    'CP_REFERRAL_NEW',
    'A customer was sent to you by RRH',
    `${lead.customer_name} is waiting in "Referred by RRH". Please accept and call them first.`,
    '/partner',
  );
  if (!isMd(user)) {
    const mds = await p.employee.findMany({
      where: {
        company_id: lead.company_id,
        status: 'ACTIVE',
        roles: { some: { role: { name: Roles.MD } } },
      },
      select: { id: true },
    });
    for (const md of mds) {
      await note(
        md.id,
        'CP_REFERRAL_SENT',
        'A lead was referred to a channel partner',
        `${lead.customer_name} (${lead.lead_code}) was referred to ${partnerName}.`,
        `/leads/${lead.id}`,
      );
    }
  }
  return referral;
}

export async function takeBackLead(user: TokenPayload, leadId: number, reason: string) {
  const why = (reason || '').trim();
  if (why.length < 3) throw new AppError(400, 'Say why the lead is being taken back');

  const scope = await buildLeadScope(user);
  const lead = await p.lead.findFirst({ where: { id: leadId, ...scope } });
  if (!lead) throw new AppError(404, 'Lead not found');
  const referral = await p.cpReferral.findFirst({
    where: { lead_id: lead.id, status: { in: OPEN_REFERRAL_STATUSES } },
  });
  if (!referral) throw new AppError(409, 'This lead is not with a channel partner');

  const allowed =
    lead.assigned_to_id === user.employeeId ||
    referral.referred_by_id === user.employeeId ||
    canManage(user);
  if (!allowed) {
    throw new AppError(
      403,
      'Only the owner, the person who referred it, the MD or a Sales Manager can take it back',
    );
  }

  await closeReferral(referral.id, 'RETURNED', why, user.employeeId);

  await p.leadActivity.create({
    data: {
      lead_id: lead.id,
      actor_id: user.employeeId,
      activity_type: 'TAKEN_BACK_FROM_PARTNER',
      notes: `Taken back from the channel partner. Reason: ${why}`,
    },
  });
  await p.auditEvent.create({
    data: {
      actor_id: user.employeeId,
      action: 'LEAD_TAKEN_BACK_FROM_CP',
      entity_type: 'LEAD',
      entity_id: lead.id,
      new_value: JSON.stringify({ referral_id: referral.id, reason: why }),
    },
  });

  await notifyEmployee(referral.cp_id, {
    type: 'CP_REFERRAL_RETURNED',
    title: 'A referred customer was taken back',
    message: `${lead.customer_name} was taken back by RRH. It is no longer in your list.`,
    link: '/partner',
  }).catch((e) => logger.error('[cpReferral] notify failed:', e));
  if (lead.assigned_to_id && lead.assigned_to_id !== user.employeeId) {
    await notifyEmployee(lead.assigned_to_id, {
      type: 'TARGET_ASSIGNED',
      title: 'A lead is back with you',
      message: `${lead.customer_name} (${lead.lead_code}) was taken back from the channel partner. Reason: ${why}`,
      link: `/leads/${lead.id}`,
    }).catch((e) => logger.error('[cpReferral] notify failed:', e));
  }
  return { ok: true };
}

/**
 * Close a referral and give the lead back to our queues. `status`: DECLINED (partner said no),
 * RETURNED (we took it back), BOOKED (a booking was confirmed), LOST (the partner lost it).
 * BOOKED and LOST leave the lead as it is in our system (the booking flow moves it on).
 */
export async function closeReferral(
  referralId: number,
  status: 'DECLINED' | 'RETURNED' | 'BOOKED' | 'LOST',
  reason: string,
  _actorId?: number,
) {
  const r = await p.cpReferral.findUnique({ where: { id: referralId } });
  if (!r || !OPEN_REFERRAL_STATUSES.includes(r.status)) return null;
  await p.$transaction([
    p.cpReferral.update({
      where: { id: r.id },
      data: {
        status,
        open_lead_id: null,
        closed_at: new Date(),
        closed_reason: reason.slice(0, 300),
      },
    }),
    p.lead.update({ where: { id: r.lead_id }, data: { referred_to_cp_id: null } }),
  ]);
  return r;
}

/** The latest referral on a lead (open first), for the "With partner" panel on our lead page. */
export async function getLeadReferral(user: TokenPayload, leadId: number) {
  const scope = await buildLeadScope(user);
  const lead = await p.lead.findFirst({ where: { id: leadId, ...scope }, select: { id: true } });
  if (!lead) throw new AppError(404, 'Lead not found');
  const referral = await p.cpReferral.findFirst({
    where: { lead_id: leadId },
    orderBy: [{ open_lead_id: 'desc' }, { id: 'desc' }],
  });
  if (!referral) return null;
  const [partner, by] = await Promise.all([
    p.employee.findUnique({
      where: { id: referral.cp_id },
      select: { full_name: true, employee_code: true },
    }),
    p.employee.findUnique({
      where: { id: referral.referred_by_id },
      select: { full_name: true, employee_code: true },
    }),
  ]);
  return {
    id: referral.id,
    status: referral.status,
    partner_stage: referral.partner_stage,
    partner_name: partner?.full_name || partner?.employee_code || 'Channel partner',
    referred_by: by?.full_name || by?.employee_code || '',
    offered_at: referral.offered_at,
    accepted_at: referral.accepted_at,
    last_activity_at: referral.last_activity_at,
    closed_at: referral.closed_at,
    closed_reason: referral.closed_reason,
    open: OPEN_REFERRAL_STATUSES.includes(referral.status),
  };
}

/**
 * A booking was confirmed: if its lead was with a partner, close the referral as BOOKED and tell the
 * partner, the person who referred it and the MD. Never throws into the booking.
 */
export async function markReferralBooked(bookingId: number, customerId: number | null) {
  try {
    const [cust, opp] = await Promise.all([
      customerId
        ? p.customer.findUnique({ where: { id: customerId }, select: { origin_lead_id: true } })
        : null,
      p.opportunity.findFirst({ where: { booking_id: bookingId }, select: { lead_id: true } }),
    ]);
    const leadIds = [cust?.origin_lead_id, opp?.lead_id].filter((x): x is number => !!x);
    if (leadIds.length === 0) return;
    const referral = await p.cpReferral.findFirst({
      where: { lead_id: { in: leadIds }, status: { in: OPEN_REFERRAL_STATUSES } },
    });
    if (!referral) return;
    await closeReferral(referral.id, 'BOOKED', 'Booking confirmed');
    const lead = await p.lead.findUnique({
      where: { id: referral.lead_id },
      select: { customer_name: true, lead_code: true },
    });
    await p.leadActivity.create({
      data: {
        lead_id: referral.lead_id,
        actor_id: referral.cp_id,
        activity_type: 'PARTNER_BOOKED',
        notes: 'The booking was confirmed while the lead was with a channel partner.',
      },
    });
    const mds = await p.employee.findMany({
      where: {
        company_id: referral.company_id,
        status: 'ACTIVE',
        roles: { some: { role: { name: Roles.MD } } },
      },
      select: { id: true },
    });
    const ids = [...new Set([referral.referred_by_id, referral.cp_id, ...mds.map((m) => m.id)])];
    for (const id of ids) {
      await notifyEmployee(id, {
        type: 'CP_REFERRAL_BOOKED',
        title: 'A referred customer booked',
        message: `${lead?.customer_name || 'The customer'} (${lead?.lead_code || ''}) booked while with the channel partner.`,
        link: id === referral.cp_id ? '/partner' : `/leads/${referral.lead_id}`,
      }).catch((e) => logger.error('[cpReferral] notify failed:', e));
    }
  } catch (e) {
    logger.error('[cpReferral] could not close the referral on booking:', e);
  }
}
