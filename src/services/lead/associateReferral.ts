import { prisma } from '../../lib/prisma';
import { TokenPayload } from '../../utils/jwt';
import { Roles } from '../../shared';
import { buildLeadScope } from '../../authz/dataScope';
import { notifyEmployee } from '../../utils/notifyEmployee';
import { logger } from '../../utils/logger';
import { AppError } from './errors';
import { associateScope } from '../associate.service';
import { REFERRABLE_STATUSES } from './cpReferral';

const p = prisma as any;

/**
 * Forward one of our leads to an associate (2026-11-23), the same idea as forwarding to a channel partner.
 *
 * The lead stays ours: the owner keeps the credit and every record. Forwarding only (1) opens an
 * AssociateReferral, the associate's separate "From RRH" list in the associate app, never mixed with the
 * customers they bring themselves, and (2) sets Lead.referred_to_associate_id so the lead leaves our callers'
 * queues until it is taken back. No automatic return: if the associate does not respond, the person who
 * forwarded it is told and takes it back by hand.
 */
export { REFERRABLE_STATUSES };
export const OPEN_ASSOCIATE_REFERRAL = ['OFFERED', 'ACCEPTED'];

const canManage = (user: TokenPayload) =>
  user.roles.some((r) => [Roles.MD, Roles.ADMIN, Roles.SALES_MANAGER].includes(r as any));
const isMd = (user: TokenPayload) => user.roles.some((r) => r === Roles.MD);

/** Associates who can receive a lead: joined, with an app login, in the person's own list. */
export async function listAssociatesForReferral(user: TokenPayload) {
  const rows = await p.associate.findMany({
    where: {
      AND: [
        await associateScope(user),
        { pipeline: { in: ['ENROLLED', 'ACTIVE', 'DORMANT'] } },
        { credential: { isNot: null } },
      ],
    },
    select: { id: true, full_name: true, associate_code: true },
    orderBy: { full_name: 'asc' },
    take: 500,
  });
  const open = await p.associateReferral.groupBy({
    by: ['associate_id'],
    where: {
      associate_id: { in: rows.map((r: any) => r.id) },
      status: { in: OPEN_ASSOCIATE_REFERRAL },
    },
    _count: { _all: true },
  });
  const counts = new Map(open.map((o: any) => [o.associate_id, o._count._all]));
  return rows.map((r: any) => ({
    id: r.id,
    name: r.associate_code ? `${r.full_name} (${r.associate_code})` : r.full_name,
    open_referrals: counts.get(r.id) || 0,
  }));
}

export async function referLeadToAssociate(
  user: TokenPayload,
  leadId: number,
  input: { associate_id: number; brief?: string },
) {
  const scope = await buildLeadScope(user);
  const lead = await p.lead.findFirst({ where: { id: leadId, ...scope } });
  if (!lead) throw new AppError(404, 'Lead not found');
  if (lead.assigned_to_id !== user.employeeId && !canManage(user)) {
    throw new AppError(
      403,
      'Only the person who owns this lead, the MD or a Sales Manager can forward it',
    );
  }
  if (!REFERRABLE_STATUSES.includes(lead.status)) {
    throw new AppError(
      409,
      'A lead can be forwarded to an associate once a site visit is planned, or at negotiation or booking in progress',
    );
  }
  if (lead.referred_to_cp_id || lead.referred_to_associate_id) {
    throw new AppError(409, 'This lead is already with a channel partner or an associate');
  }
  const associate = await p.associate.findFirst({
    where: {
      id: input.associate_id,
      company_id: lead.company_id,
      pipeline: { in: ['ENROLLED', 'ACTIVE', 'DORMANT'] },
      credential: { isNot: null },
      ...(await associateScope(user)),
    },
    select: { id: true, full_name: true, owner_cpm_id: true },
  });
  if (!associate)
    throw new AppError(400, 'That associate cannot receive leads (they need an app login)');
  const brief = (input.brief || '').trim().slice(0, 1500) || null;

  const referral = await p.$transaction(async (tx: any) => {
    const r = await tx.associateReferral.create({
      data: {
        company_id: lead.company_id,
        lead_id: lead.id,
        associate_id: associate.id,
        referred_by_id: user.employeeId,
        brief,
        stage_at_referral: lead.status,
        open_lead_id: lead.id,
      },
    });
    await tx.lead.update({
      where: { id: lead.id },
      data: { referred_to_associate_id: associate.id },
    });
    await tx.leadActivity.create({
      data: {
        lead_id: lead.id,
        actor_id: user.employeeId,
        activity_type: 'REFERRED_TO_ASSOCIATE',
        notes: `Forwarded to associate ${associate.full_name} at ${lead.status}.${brief ? ` Brief: ${brief}` : ''}`,
      },
    });
    await tx.auditEvent.create({
      data: {
        actor_id: user.employeeId,
        action: 'LEAD_REFERRED_TO_ASSOCIATE',
        entity_type: 'LEAD',
        entity_id: lead.id,
        new_value: JSON.stringify({
          associate_id: associate.id,
          referral_id: r.id,
          stage: lead.status,
        }),
      },
    });
    return r;
  });

  // The associate sees it in their app. Staff who should know: the associate's manager, and the MD.
  const note = (id: number, title: string, message: string) =>
    notifyEmployee(id, {
      type: 'ASSOCIATE_REFERRAL_SENT',
      title,
      message,
      link: `/leads/${lead.id}`,
    }).catch((e) => logger.error('[associateReferral] notify failed:', e));
  const people = new Set<number>();
  if (associate.owner_cpm_id && associate.owner_cpm_id !== user.employeeId)
    people.add(associate.owner_cpm_id);
  if (!isMd(user)) {
    const mds = await p.employee.findMany({
      where: {
        company_id: lead.company_id,
        status: 'ACTIVE',
        roles: { some: { role: { name: Roles.MD } } },
      },
      select: { id: true },
    });
    for (const m of mds) people.add(m.id);
  }
  for (const id of people) {
    await note(
      id,
      'A lead was forwarded to an associate',
      `${lead.customer_name} (${lead.lead_code}) was forwarded to ${associate.full_name}.`,
    );
  }
  return referral;
}

/** Close a referral and give the lead back to our queues (DECLINED, RETURNED, BOOKED or LOST). */
export async function closeAssociateReferral(
  referralId: number,
  status: 'DECLINED' | 'RETURNED' | 'BOOKED' | 'LOST',
  reason: string,
) {
  const r = await p.associateReferral.findUnique({ where: { id: referralId } });
  if (!r || !OPEN_ASSOCIATE_REFERRAL.includes(r.status)) return null;
  await p.$transaction([
    p.associateReferral.update({
      where: { id: r.id },
      data: {
        status,
        open_lead_id: null,
        closed_at: new Date(),
        closed_reason: reason.slice(0, 300),
      },
    }),
    p.lead.update({ where: { id: r.lead_id }, data: { referred_to_associate_id: null } }),
  ]);
  return r;
}

export async function takeBackFromAssociate(user: TokenPayload, leadId: number, reason: string) {
  const why = (reason || '').trim();
  if (why.length < 3) throw new AppError(400, 'Say why the lead is being taken back');
  const scope = await buildLeadScope(user);
  const lead = await p.lead.findFirst({ where: { id: leadId, ...scope } });
  if (!lead) throw new AppError(404, 'Lead not found');
  const referral = await p.associateReferral.findFirst({
    where: { lead_id: lead.id, status: { in: OPEN_ASSOCIATE_REFERRAL } },
  });
  if (!referral) throw new AppError(409, 'This lead is not with an associate');
  const allowed =
    lead.assigned_to_id === user.employeeId ||
    referral.referred_by_id === user.employeeId ||
    canManage(user);
  if (!allowed) {
    throw new AppError(
      403,
      'Only the owner, the person who forwarded it, the MD or a Sales Manager can take it back',
    );
  }
  await closeAssociateReferral(referral.id, 'RETURNED', why);
  await p.leadActivity.create({
    data: {
      lead_id: lead.id,
      actor_id: user.employeeId,
      activity_type: 'TAKEN_BACK_FROM_ASSOCIATE',
      notes: `Taken back from the associate. Reason: ${why}`,
    },
  });
  await p.auditEvent.create({
    data: {
      actor_id: user.employeeId,
      action: 'LEAD_TAKEN_BACK_FROM_ASSOCIATE',
      entity_type: 'LEAD',
      entity_id: lead.id,
      new_value: JSON.stringify({ referral_id: referral.id, reason: why }),
    },
  });
  if (lead.assigned_to_id && lead.assigned_to_id !== user.employeeId) {
    await notifyEmployee(lead.assigned_to_id, {
      type: 'TARGET_ASSIGNED',
      title: 'A lead is back with you',
      message: `${lead.customer_name} (${lead.lead_code}) was taken back from the associate. Reason: ${why}`,
      link: `/leads/${lead.id}`,
    }).catch((e) => logger.error('[associateReferral] notify failed:', e));
  }
  return { ok: true };
}

/** The latest referral on a lead (open first), for the "With associate" panel on our lead page. */
export async function getLeadAssociateReferral(user: TokenPayload, leadId: number) {
  const scope = await buildLeadScope(user);
  const lead = await p.lead.findFirst({ where: { id: leadId, ...scope }, select: { id: true } });
  if (!lead) throw new AppError(404, 'Lead not found');
  const referral = await p.associateReferral.findFirst({
    where: { lead_id: leadId },
    orderBy: [{ open_lead_id: 'desc' }, { id: 'desc' }],
  });
  if (!referral) return null;
  const [assoc, by] = await Promise.all([
    p.associate.findUnique({ where: { id: referral.associate_id }, select: { full_name: true } }),
    p.employee.findUnique({
      where: { id: referral.referred_by_id },
      select: { full_name: true, employee_code: true },
    }),
  ]);
  return {
    id: referral.id,
    status: referral.status,
    associate_stage: referral.associate_stage,
    associate_note: referral.associate_note,
    associate_name: assoc?.full_name || 'Associate',
    referred_by: by?.full_name || by?.employee_code || '',
    offered_at: referral.offered_at,
    accepted_at: referral.accepted_at,
    last_activity_at: referral.last_activity_at,
    closed_at: referral.closed_at,
    closed_reason: referral.closed_reason,
    open: OPEN_ASSOCIATE_REFERRAL.includes(referral.status),
  };
}

/** A booking was confirmed on a lead that was with an associate: close it as BOOKED and tell the people involved. */
export async function markAssociateReferralBooked(bookingId: number, customerId: number | null) {
  try {
    const [cust, opp] = await Promise.all([
      customerId
        ? p.customer.findUnique({ where: { id: customerId }, select: { origin_lead_id: true } })
        : null,
      p.opportunity.findFirst({ where: { booking_id: bookingId }, select: { lead_id: true } }),
    ]);
    const leadIds = [cust?.origin_lead_id, opp?.lead_id].filter((x): x is number => !!x);
    if (leadIds.length === 0) return;
    const referral = await p.associateReferral.findFirst({
      where: { lead_id: { in: leadIds }, status: { in: OPEN_ASSOCIATE_REFERRAL } },
    });
    if (!referral) return;
    await closeAssociateReferral(referral.id, 'BOOKED', 'Booking confirmed');
    const [lead, assoc] = await Promise.all([
      p.lead.findUnique({
        where: { id: referral.lead_id },
        select: { customer_name: true, lead_code: true },
      }),
      p.associate.findUnique({
        where: { id: referral.associate_id },
        select: { full_name: true, owner_cpm_id: true },
      }),
    ]);
    await p.leadActivity.create({
      data: {
        lead_id: referral.lead_id,
        actor_id: referral.referred_by_id,
        activity_type: 'ASSOCIATE_BOOKED',
        notes: `The booking was confirmed while the lead was with ${assoc?.full_name || 'an associate'}.`,
      },
    });
    const ids = [
      ...new Set([referral.referred_by_id, assoc?.owner_cpm_id].filter((x): x is number => !!x)),
    ];
    for (const id of ids) {
      await notifyEmployee(id, {
        type: 'ASSOCIATE_REFERRAL_BOOKED',
        title: 'A forwarded customer booked',
        message: `${lead?.customer_name || 'The customer'} (${lead?.lead_code || ''}) booked while with ${assoc?.full_name || 'the associate'}.`,
        link: `/leads/${referral.lead_id}`,
      }).catch((e) => logger.error('[associateReferral] notify failed:', e));
    }
  } catch (e) {
    logger.error('[associateReferral] could not close the referral on booking:', e);
  }
}
