import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';
import { Permissions } from '../shared';
import { notifyEmployee } from '../utils/notifyEmployee';
import { requireCp, requireOwner, asUser, CpRequest } from './cp';
import { bookVisit } from '../services/siteVisit/booking';
import { closeReferral, OPEN_REFERRAL_STATUSES } from '../services/lead/cpReferral';

/**
 * "Referred by RRH" (2026-11-23): company leads our staff hand to an external partner.
 *
 * This is a SEPARATE inbox from the partner's own private leads (CpLead): different table, different
 * routes, never counted in the partner's own lead lists or reports. The lead itself stays ours.
 * As everywhere in the partner area, the group (req.cp.id) comes from the signed token, never from the
 * request, and a partner's telecaller sees only the referrals assigned to them.
 *
 * What the partner sees of the customer is an allow-list (name, phone, interest, budget, stage, the
 * referrer's brief). Our internal notes, activity history, score and staff names are never returned.
 */
const router = Router();
const p = prisma as any;

const handle =
  (fn: (req: CpRequest, res: Response) => Promise<unknown>) =>
  async (req: CpRequest, res: Response, next: NextFunction) => {
    try {
      await fn(req, res);
    } catch (e: any) {
      if (e && typeof e.status === 'number' && e.message) {
        return res.status(e.status).json({ error: e.message });
      }
      logger.error({ err: e }, 'Partner referral error');
      next(e);
    }
  };
const fail = (status: number, message: string) => ({ status, message });
const idOf = (raw: unknown) => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw fail(400, 'Invalid ID format');
  return n;
};
const actorName = (req: CpRequest) => req.cp!.user?.full_name || req.cp!.full_name || 'Partner';

/** The referrals this person may see: the partner sees the group's; a telecaller sees theirs. */
const scopeOf = (req: CpRequest) =>
  req.cp!.user ? { cp_id: req.cp!.id, assigned_to_id: req.cp!.user.id } : { cp_id: req.cp!.id };

const leadSelect = {
  id: true,
  lead_code: true,
  customer_name: true,
  phone: true,
  email: true,
  budget_min: true,
  budget_max: true,
  preferred_location: true,
  property_type_preference: true,
  status: true,
  project: { select: { id: true, name: true, location: true } },
} as const;

const view = (r: any) => ({
  id: r.id,
  status: r.status,
  partner_stage: r.partner_stage,
  stage_at_referral: r.stage_at_referral,
  brief: r.brief,
  offered_at: r.offered_at,
  accepted_at: r.accepted_at,
  last_activity_at: r.last_activity_at,
  closed_at: r.closed_at,
  closed_reason: r.closed_reason,
  assigned_to_id: r.assigned_to_id,
  customer: {
    name: r.lead?.customer_name,
    phone: r.lead?.phone,
    email: r.lead?.email,
    budget_min: r.lead?.budget_min,
    budget_max: r.lead?.budget_max,
    preferred_location: r.lead?.preferred_location,
    property_type: r.lead?.property_type_preference,
    project: r.lead?.project ? { id: r.lead.project.id, name: r.lead.project.name } : null,
    stage: r.lead?.status,
  },
});

/** CpReferral has no database link to Lead (like the other partner tables), so the leads are read separately. */
const withLeads = async (rows: any[]) => {
  const leads = await p.lead.findMany({
    where: { id: { in: [...new Set(rows.map((r) => r.lead_id))] } },
    select: leadSelect,
  });
  const byId = new Map<number, any>(leads.map((l: any) => [l.id, l]));
  // A referral whose lead has since been deleted has nothing to show (it broke the partner's screen).
  return rows.map((r) => ({ ...r, lead: byId.get(r.lead_id) })).filter((r) => r.lead);
};

const own = async (req: CpRequest, id: number) => {
  const r = await p.cpReferral.findFirst({
    where: { id, ...scopeOf(req), company_id: req.cp!.company_id },
  });
  const [found] = r ? await withLeads([r]) : [];
  if (!found) throw fail(404, 'Referral not found');
  return found;
};
const open = (r: any) => {
  if (!OPEN_REFERRAL_STATUSES.includes(r.status)) throw fail(409, 'This referral is closed.');
  return r;
};

/** Tell the person who referred it and the lead's owner (once each), on our side. */
const tellOurSide = async (r: any, type: string, title: string, message: string) => {
  const lead = await p.lead.findUnique({
    where: { id: r.lead_id },
    select: { assigned_to_id: true },
  });
  const ids = [...new Set([r.referred_by_id, lead?.assigned_to_id].filter(Boolean))] as number[];
  for (const id of ids) {
    await notifyEmployee(id, { type, title, message, link: `/leads/${r.lead_id}` }).catch((e) =>
      logger.error('[cpReferred] notify failed:', e),
    );
  }
};

/** What the partner did, shown on our lead page. Notes stay with the partner. */
const mirror = (r: any, req: CpRequest, activity_type: string, notes: string) =>
  p.leadActivity.create({
    data: { lead_id: r.lead_id, actor_id: req.cp!.id, activity_type, notes },
  });

const touch = (id: number, data: Record<string, unknown> = {}) =>
  p.cpReferral.update({ where: { id }, data: { last_activity_at: new Date(), ...data } });

router.get(
  '/referred',
  requireCp,
  handle(async (req, res) => {
    const closed = req.query.scope === 'closed';
    const rows = await p.cpReferral.findMany({
      where: {
        ...scopeOf(req),
        company_id: req.cp!.company_id,
        status: closed ? { notIn: OPEN_REFERRAL_STATUSES } : { in: OPEN_REFERRAL_STATUSES },
      },
      orderBy: closed ? { closed_at: 'desc' } : { offered_at: 'desc' },
      take: 200,
    });
    const every = await withLeads(
      await p.cpReferral.findMany({
        where: { ...scopeOf(req), company_id: req.cp!.company_id },
        select: { status: true, lead_id: true },
      }),
    );
    const n = (s: string) => every.filter((c: any) => c.status === s).length;
    return res.status(200).json({
      referrals: (await withLeads(rows)).map(view),
      counts: {
        waiting: n('OFFERED'),
        working: n('ACCEPTED'),
        closed: n('DECLINED') + n('RETURNED') + n('BOOKED') + n('LOST'),
      },
    });
  }),
);

router.get(
  '/referred/:id',
  requireCp,
  handle(async (req, res) => {
    const r = await own(req, idOf(req.params.id));
    const [activities, visits, team] = await Promise.all([
      p.cpReferralActivity.findMany({
        where: { referral_id: r.id, cp_id: req.cp!.id },
        orderBy: { created_at: 'desc' },
        take: 100,
      }),
      p.siteVisitBooking.findMany({
        where: { lead_id: r.lead_id, created_at: { gte: r.offered_at } },
        select: {
          id: true,
          booking_code: true,
          scheduled_date: true,
          status: true,
          project: { select: { name: true, location: true } },
          project_manager: { select: { full_name: true, phone: true } },
        },
        orderBy: { scheduled_date: 'desc' },
        take: 20,
      }),
      req.cp!.user
        ? Promise.resolve([])
        : p.cpUser.findMany({
            where: { cp_id: req.cp!.id, is_active: true },
            select: { id: true, full_name: true },
          }),
    ]);
    return res.status(200).json({
      referral: view(r),
      activities: activities.map((a: any) => ({
        id: a.id,
        kind: a.kind,
        outcome: a.outcome,
        notes: a.notes,
        actor_name: a.actor_name,
        created_at: a.created_at,
      })),
      visits: visits.map((v: any) => ({
        id: v.id,
        booking_code: v.booking_code,
        scheduled_date: v.scheduled_date,
        status: v.status,
        place: v.project ? { name: v.project.name, location: v.project.location } : null,
        pm: v.project_manager
          ? { name: v.project_manager.full_name, phone: v.project_manager.phone }
          : null,
      })),
      team,
    });
  }),
);

router.post(
  '/referred/:id/accept',
  requireCp,
  handle(async (req, res) => {
    const r = open(await own(req, idOf(req.params.id)));
    if (r.status === 'OFFERED') {
      await touch(r.id, { status: 'ACCEPTED', accepted_at: new Date() });
      await p.cpReferralActivity.create({
        data: {
          referral_id: r.id,
          cp_id: req.cp!.id,
          actor_user_id: req.cp!.user?.id ?? null,
          actor_name: actorName(req),
          kind: 'STATUS',
          notes: 'Accepted the referral.',
        },
      });
      await mirror(r, req, 'PARTNER_ACCEPTED', `${actorName(req)} accepted the referral.`);
    }
    return res.status(200).json({ ok: true });
  }),
);

const DeclineSchema = z.object({ reason: z.string().trim().min(3).max(300) });
router.post(
  '/referred/:id/decline',
  requireCp,
  requireOwner,
  handle(async (req, res) => {
    const body = DeclineSchema.safeParse(req.body);
    if (!body.success) throw fail(400, 'Say briefly why you cannot take this customer.');
    const r = open(await own(req, idOf(req.params.id)));
    await closeReferral(r.id, 'DECLINED', body.data.reason);
    await p.cpReferralActivity.create({
      data: {
        referral_id: r.id,
        cp_id: req.cp!.id,
        actor_user_id: req.cp!.user?.id ?? null,
        actor_name: actorName(req),
        kind: 'STATUS',
        notes: `Declined: ${body.data.reason}`,
      },
    });
    await mirror(r, req, 'PARTNER_DECLINED', `The partner declined. Reason: ${body.data.reason}`);
    await tellOurSide(
      r,
      'CP_REFERRAL_DECLINED',
      'A partner declined a referred lead',
      `${r.lead?.customer_name} came back from the partner. Reason: ${body.data.reason}`,
    );
    return res.status(200).json({ ok: true });
  }),
);

const CallSchema = z.object({
  outcome: z.enum(['ANSWERED', 'NO_ANSWER', 'BUSY', 'WRONG_NUMBER']),
  notes: z.string().trim().max(500).optional().nullable(),
});
router.post(
  '/referred/:id/call',
  requireCp,
  handle(async (req, res) => {
    const body = CallSchema.safeParse(req.body);
    if (!body.success) throw fail(400, 'Choose what happened on the call.');
    const r = open(await own(req, idOf(req.params.id)));
    await touch(
      r.id,
      r.status === 'OFFERED' ? { status: 'ACCEPTED', accepted_at: new Date() } : {},
    );
    await p.cpReferralActivity.create({
      data: {
        referral_id: r.id,
        cp_id: req.cp!.id,
        actor_user_id: req.cp!.user?.id ?? null,
        actor_name: actorName(req),
        kind: 'CALL',
        outcome: body.data.outcome,
        notes: body.data.notes || null,
      },
    });
    await mirror(
      r,
      req,
      'PARTNER_CALL',
      `${actorName(req)} called the customer (${body.data.outcome.replace('_', ' ').toLowerCase()}).`,
    );
    return res.status(200).json({ ok: true });
  }),
);

router.post(
  '/referred/:id/note',
  requireCp,
  handle(async (req, res) => {
    const body = z.object({ notes: z.string().trim().min(2).max(1000) }).safeParse(req.body);
    if (!body.success) throw fail(400, 'Write the note.');
    const r = open(await own(req, idOf(req.params.id)));
    await touch(r.id);
    await p.cpReferralActivity.create({
      data: {
        referral_id: r.id,
        cp_id: req.cp!.id,
        actor_user_id: req.cp!.user?.id ?? null,
        actor_name: actorName(req),
        kind: 'NOTE',
        notes: body.data.notes,
      },
    });
    return res.status(200).json({ ok: true });
  }),
);

const STAGES = ['CONTACTED', 'INTERESTED', 'NEGOTIATING', 'NOT_INTERESTED'] as const;
router.post(
  '/referred/:id/status',
  requireCp,
  handle(async (req, res) => {
    const body = z
      .object({ stage: z.enum(STAGES), notes: z.string().trim().max(300).optional().nullable() })
      .safeParse(req.body);
    if (!body.success) throw fail(400, 'Choose where this customer stands.');
    const r = open(await own(req, idOf(req.params.id)));
    await touch(r.id, {
      partner_stage: body.data.stage,
      ...(r.status === 'OFFERED' ? { status: 'ACCEPTED', accepted_at: new Date() } : {}),
    });
    await p.cpReferralActivity.create({
      data: {
        referral_id: r.id,
        cp_id: req.cp!.id,
        actor_user_id: req.cp!.user?.id ?? null,
        actor_name: actorName(req),
        kind: 'STATUS',
        outcome: body.data.stage,
        notes: body.data.notes || null,
      },
    });
    await mirror(
      r,
      req,
      'PARTNER_STATUS',
      `Partner update: ${body.data.stage.replace('_', ' ').toLowerCase()}.`,
    );
    if (body.data.stage === 'NOT_INTERESTED') {
      await tellOurSide(
        r,
        'CP_REFERRAL_DECLINED',
        'A partner says the customer is not interested',
        `${r.lead?.customer_name}: the partner marked the customer not interested. You can take the lead back.`,
      );
    }
    return res.status(200).json({ ok: true });
  }),
);

router.post(
  '/referred/:id/assign',
  requireCp,
  requireOwner,
  handle(async (req, res) => {
    const body = z
      .object({ cp_user_id: z.number().int().positive().nullable() })
      .safeParse(req.body);
    if (!body.success) throw fail(400, 'Choose a telecaller.');
    const r = open(await own(req, idOf(req.params.id)));
    let name = 'yourself';
    if (body.data.cp_user_id) {
      const u = await p.cpUser.findFirst({
        where: { id: body.data.cp_user_id, cp_id: req.cp!.id, is_active: true },
        select: { full_name: true },
      });
      if (!u) throw fail(404, 'Telecaller not found');
      name = u.full_name;
    }
    await touch(r.id, { assigned_to_id: body.data.cp_user_id });
    await p.cpReferralActivity.create({
      data: {
        referral_id: r.id,
        cp_id: req.cp!.id,
        actor_user_id: null,
        actor_name: actorName(req),
        kind: 'ASSIGN',
        notes: `Given to ${name}.`,
      },
    });
    return res.status(200).json({ ok: true });
  }),
);

const VisitSchema = z
  .object({
    project_id: z.number().int().positive().optional().nullable(),
    property_id: z.number().int().positive().optional().nullable(),
    scheduled_date: z.string().min(8),
    mode: z.enum(['SELF', 'OUR_PM']),
    notes: z.string().trim().max(500).optional().nullable(),
  })
  .refine((v) => !!v.project_id || !!v.property_id, {
    message: 'Pick the project or property to visit.',
  });

router.post(
  '/referred/:id/visit',
  requireCp,
  handle(async (req, res) => {
    const body = VisitSchema.safeParse(req.body);
    if (!body.success) throw fail(400, body.error.issues[0]?.message || 'Check the visit details.');
    const when = new Date(body.data.scheduled_date);
    if (Number.isNaN(when.getTime()) || when.getTime() < Date.now() - 3600e3) {
      throw fail(400, 'Pick a date and time that has not passed.');
    }
    const cp = req.cp!;
    const r = open(await own(req, idOf(req.params.id)));
    if (body.data.project_id) {
      const ok = await p.project.findFirst({
        where: {
          id: body.data.project_id,
          company_id: cp.company_id,
          status: { not: 'CANCELLED' },
        },
        select: { id: true },
      });
      if (!ok) throw fail(404, 'Project not found');
    } else {
      const ok = await p.property.findFirst({
        where: { id: body.data.property_id, status: 'LIVE' },
        select: { id: true },
      });
      if (!ok) throw fail(404, 'Property not found');
    }
    // The visit is booked on OUR lead; cp_owner_id is left alone (the customer is not the partner's own).
    const self = body.data.mode === 'SELF';
    const user = { ...asUser(req), permissions: [Permissions.SITE_VISITS_CREATE] };
    const visit: any = await bookVisit(user as any, {
      lead_id: r.lead_id,
      scheduled_date: when.toISOString(),
      project_id: body.data.project_id || undefined,
      property_id: body.data.property_id || undefined,
      notes:
        `Booked by ${actorName(req)} (channel partner ${cp.full_name || cp.employee_code}, referred lead). ${body.data.notes || ''}`.trim(),
      direct: self,
    });
    if (self) {
      await p.siteVisitBooking.update({
        where: { id: visit.id },
        data: { assigned_agent_id: cp.id },
      });
    }
    await touch(r.id, {
      partner_stage: 'VISIT_BOOKED',
      ...(r.status === 'OFFERED' ? { status: 'ACCEPTED', accepted_at: new Date() } : {}),
    });
    await p.cpReferralActivity.create({
      data: {
        referral_id: r.id,
        cp_id: cp.id,
        actor_user_id: cp.user?.id ?? null,
        actor_name: actorName(req),
        kind: 'VISIT',
        outcome: self ? 'SELF' : 'OUR_PM',
        notes: `Site visit ${visit.booking_code} booked (${self ? 'you run it' : 'our project manager runs it'}).`,
      },
    });
    return res
      .status(201)
      .json({ visit: { id: visit.id, booking_code: visit.booking_code, status: visit.status } });
  }),
);

export default router;
