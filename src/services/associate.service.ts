import { Prisma } from '@prisma/client';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { TokenPayload } from '../utils/jwt';
import { Roles } from '../shared';
import { AppError } from './lead/errors';
import { getAccessibleCompanyIds } from '../authz/dataScope';
import { getISTComponents, getISTMidnightInstant } from '../utils/time';
import { updateLeadStatus } from './lead/status';
import { notifyEmployee } from '../utils/notifyEmployee';
import { logger } from '../utils/logger';
import { SPOKE_OUTCOMES } from './associateWork';
import { officeVisitsOf } from './associateOfficeVisit';

// Associates (freelance agents who bring leads) and the Channel Partner
// Manager's work with them: the list, follow-ups, the daily queue and lead
// status reported on an associate's behalf. MD and Technical Manager (Admin
// in the token) see every associate in their companies; a CPM sees their own
// plus the unassigned ones. Follow-ups are associate follow-ups, never
// customer calls: nothing here writes a CALL_LOGGED activity.

const p = prisma;
const DAY = 24 * 60 * 60 * 1000;

export const PIPELINES = [
  'INVITED',
  'CONTACTED',
  'AGREED',
  'DOCUMENTS',
  'ENROLLED',
  'ACTIVE',
  'DORMANT',
  'LEFT',
] as const;
export const PROSPECT_STAGES = ['INVITED', 'CONTACTED', 'AGREED', 'DOCUMENTS'];
export const LOGIN_STAGES = ['ENROLLED', 'ACTIVE', 'DORMANT'];
export const OUTCOMES = [
  'REACHED',
  'NO_ANSWER',
  'BUSY',
  'WRONG_NUMBER',
  'CALL_BACK',
  // Answers when calling someone who has not joined yet (2026-11-23)
  'AGREED',
  'THINKING',
  'DECLINED',
  // Answers when calling an associate who has joined
  'HAS_LEAD',
  'WANTS_VISIT',
  'NO_UPDATE',
] as const;
export const PROSPECT_OUTCOMES = ['AGREED', 'THINKING', 'DECLINED'];
export const JOINED_OUTCOMES = ['HAS_LEAD', 'WANTS_VISIT', 'NO_UPDATE'];
export const CHANNELS = ['CALL', 'WHATSAPP', 'OFFICE_VISIT', 'SITE_VISIT'] as const;
/** Leads that need no more follow-up. */
export const CLOSED_LEAD = ['BOOKED', 'DROPPED', 'RECOVERED_TO_POOL'];
export const ASSOCIATE_REPORT_ACTIVITY = 'ASSOCIATE_REPORT';

export const REPORTS: Record<string, string> = {
  NO_CHANGE: 'No change',
  CUSTOMER_SPOKE: 'Customer spoke',
  INTERESTED: 'Interested',
  WANTS_VISIT: 'Wants a site visit',
  VISITED: 'Visited',
  NEGOTIATING: 'Negotiating',
  NOT_INTERESTED: 'Not interested',
  BOOKED: 'Booked or paid',
  CANNOT_REACH: 'Cannot reach customer',
};

// Lead stages in order, to tell "the CRM is already further on".
const STAGE_ORDER = [
  'NEW',
  'ASSIGNED',
  'CONTACTED',
  'QUALIFIED',
  'DEMO_SCHEDULED',
  'DEMO_COMPLETED',
  'SITE_VISIT_SCHEDULED',
  'SITE_VISIT_COMPLETED',
  'NEGOTIATION',
  'BOOKING_INITIATED',
  'BOOKED',
];
const rank = (s: string) => STAGE_ORDER.indexOf(s);

export const DEFAULT_SETTINGS = {
  quiet_days: 3,
  stale_days: 7,
  escalate_days: 14,
  dormant_days: 60,
};
export type AssociateSettings = typeof DEFAULT_SETTINGS;

/** The 10 digits of an Indian mobile however it was typed. */
export const tenDigits = (raw: unknown) => {
  let d = String(raw ?? '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return d;
};
export const maskPhone = (raw: unknown) => {
  const d = String(raw ?? '').replace(/\D/g, '');
  return d.length >= 4 ? `******${d.slice(-4)}` : '****';
};

export const seesAllAssociates = (u: TokenPayload) =>
  u.roles.includes(Roles.MD) || u.roles.includes(Roles.ADMIN);

export async function associateScope(user: TokenPayload): Promise<Prisma.AssociateWhereInput> {
  const companyIds = await getAccessibleCompanyIds(user);
  if (seesAllAssociates(user)) return { company_id: { in: companyIds } };
  return {
    company_id: { in: companyIds },
    OR: [{ owner_cpm_id: user.employeeId }, { owner_cpm_id: null }],
  };
}

const inScope = (user: TokenPayload, a: { owner_cpm_id: number | null }) =>
  seesAllAssociates(user) || a.owner_cpm_id === null || a.owner_cpm_id === user.employeeId;

async function getInScope(user: TokenPayload, id: number) {
  const a = await p.associate.findFirst({ where: { id, ...(await associateScope(user)) } });
  if (!a) throw new AppError(404, 'Associate not found');
  return a;
}

const dayStart = (d: Date) => getISTMidnightInstant(getISTComponents(d).dateString);
/** "YYYY-MM-DD" is that day in India; anything else is read as a date and time. */
const parseDay = (v: string) => {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? getISTMidnightInstant(v) : new Date(v);
  if (Number.isNaN(d.getTime())) throw new AppError(400, 'Enter a valid date');
  return d;
};
const label = (a: { full_name: string; associate_code: string | null }) =>
  a.associate_code ? `${a.full_name} (${a.associate_code})` : a.full_name;

export async function settingsFor(companyIds: number[]) {
  const rows = await p.associateSetting.findMany({ where: { company_id: { in: companyIds } } });
  const map = new Map<number, AssociateSettings>();
  for (const id of companyIds) map.set(id, { ...DEFAULT_SETTINGS });
  for (const r of rows)
    map.set(r.company_id, {
      quiet_days: r.quiet_days,
      stale_days: r.stale_days,
      escalate_days: r.escalate_days,
      dormant_days: r.dormant_days,
    });
  return map;
}

export async function getSettings(user: TokenPayload) {
  return (await settingsFor([user.companyId])).get(user.companyId)!;
}

export async function saveSettings(user: TokenPayload, body: Partial<AssociateSettings>) {
  const data = { ...(await getSettings(user)), ...body, updated_by_id: user.employeeId };
  await p.associateSetting.upsert({
    where: { company_id: user.companyId },
    create: { company_id: user.companyId, ...data },
    update: data,
  });
  return getSettings(user);
}

/** Open leads of these associates with the time each was last worked on. */
export async function openLeadSilence(associateIds: number[]) {
  if (associateIds.length === 0) return [];
  const leads = await p.lead.findMany({
    where: { associate_id: { in: associateIds }, status: { notIn: CLOSED_LEAD } },
    select: {
      id: true,
      associate_id: true,
      created_at: true,
      lead_code: true,
      customer_name: true,
      status: true,
    },
  });
  const last = await lastActivity(leads.map((l) => l.id));
  return leads.map((l) => {
    const a = last.get(l.id);
    return {
      ...l,
      associate_id: l.associate_id!,
      last_update: a && a > l.created_at ? a : l.created_at,
    };
  });
}

/** Latest activity per lead (a reassignment is not an update). */
async function lastActivity(leadIds: number[]) {
  const out = new Map<number, Date>();
  for (let i = 0; i < leadIds.length; i += 1000) {
    const rows = await p.leadActivity.groupBy({
      by: ['lead_id'],
      where: {
        lead_id: { in: leadIds.slice(i, i + 1000) },
        activity_type: { not: 'ASSIGNED_TO_AGENT' },
      },
      _max: { created_at: true },
    });
    for (const r of rows) if (r._max.created_at) out.set(r.lead_id, r._max.created_at);
  }
  return out;
}

const SUMMARY_SELECT = {
  id: true,
  company_id: true,
  associate_code: true,
  full_name: true,
  phone: true,
  email: true,
  designation: true,
  pipeline: true,
  owner_cpm_id: true,
  upline_id: true,
  next_follow_up_at: true,
  last_contacted_at: true,
  source: true,
  owner: { select: { id: true, full_name: true } },
} satisfies Prisma.AssociateSelect;

// ---- List, add, edit ----

export async function listAssociates(
  user: TokenPayload,
  q: { search?: string; pipeline?: string; owner?: string; page?: number },
) {
  const scope = await associateScope(user);
  const and: Prisma.AssociateWhereInput[] = [scope];
  const s = q.search?.trim();
  if (s) {
    const digits = s.replace(/\D/g, '');
    and.push({
      OR: [
        { full_name: { contains: s } },
        { associate_code: { contains: s } },
        ...(digits.length >= 3 ? [{ phone: { contains: digits } }] : []),
      ],
    });
  }
  if (q.owner === 'me') and.push({ owner_cpm_id: user.employeeId });
  else if (q.owner === 'none') and.push({ owner_cpm_id: null });
  else if (q.owner && /^\d+$/.test(q.owner)) and.push({ owner_cpm_id: Number(q.owner) });
  const base: Prisma.AssociateWhereInput = { AND: and };
  const where: Prisma.AssociateWhereInput =
    q.pipeline && (PIPELINES as readonly string[]).includes(q.pipeline)
      ? { AND: [...and, { pipeline: q.pipeline }] }
      : base;
  const page = Math.max(1, q.page || 1);
  const [rows, total, counts] = await Promise.all([
    p.associate.findMany({
      where,
      select: { ...SUMMARY_SELECT, _count: { select: { leads: true } } },
      orderBy: [{ full_name: 'asc' }],
      skip: (page - 1) * 50,
      take: 50,
    }),
    p.associate.count({ where }),
    p.associate.groupBy({ by: ['pipeline'], where: base, _count: { _all: true } }),
  ]);
  return {
    associates: rows.map(({ _count, ...r }) => ({ ...r, leads: _count.leads })),
    total,
    page,
    page_size: 50,
    pipeline_counts: Object.fromEntries(counts.map((c) => [c.pipeline, c._count._all])),
  };
}

export interface AssociateInput {
  full_name?: string;
  phone?: string;
  associate_code?: string | null;
  email?: string | null;
  designation?: string | null;
  upline_id?: number | null;
  owner_cpm_id?: number | null;
  pipeline?: string;
  notes?: string | null;
  next_follow_up_at?: string | null;
}

/** Who may own an associate: a CPM only themselves (or nobody); MD/TM any active CPM. */
async function checkOwner(user: TokenPayload, companyId: number, ownerId: number | null) {
  if (ownerId === null) return null;
  if (!seesAllAssociates(user) && ownerId !== user.employeeId) {
    throw new AppError(
      403,
      'You can take an associate yourself, but only the MD can give one to another CPM.',
    );
  }
  const cpm = await p.employee.findFirst({
    where: {
      id: ownerId,
      company_id: companyId,
      status: 'ACTIVE',
      roles: { some: { role: { name: Roles.CHANNEL_PARTNER_MANAGER } } },
    },
    select: { id: true },
  });
  if (!cpm && ownerId !== user.employeeId) {
    throw new AppError(400, 'Choose an active Channel Partner Manager of this company.');
  }
  return ownerId;
}

/** True when making `parentId` the upline of `childId` would form a loop. */
export function wouldLoop(parents: Map<number, number | null>, childId: number, parentId: number) {
  let cur: number | null | undefined = parentId;
  for (let i = 0; cur && i < 10000; i++) {
    if (cur === childId) return true;
    cur = parents.get(cur);
  }
  return false;
}

async function checkUpline(companyId: number, selfId: number | null, uplineId: number | null) {
  if (uplineId === null) return null;
  if (uplineId === selfId) throw new AppError(400, 'An associate cannot be their own upline.');
  const up = await p.associate.findFirst({ where: { id: uplineId, company_id: companyId } });
  if (!up) throw new AppError(400, 'Upline not found in this company.');
  if (selfId) {
    const all = await p.associate.findMany({
      where: { company_id: companyId },
      select: { id: true, upline_id: true },
    });
    if (wouldLoop(new Map(all.map((a) => [a.id, a.upline_id])), selfId, uplineId)) {
      throw new AppError(400, 'That upline is already in this associate’s downline.');
    }
  }
  return uplineId;
}

async function phoneTaken(user: TokenPayload, companyId: number, phone: string, selfId?: number) {
  const other = await p.associate.findFirst({
    where: { company_id: companyId, phone, ...(selfId ? { id: { not: selfId } } : {}) },
  });
  if (other) {
    throw new AppError(
      409,
      inScope(user, other)
        ? `This number already belongs to ${label(other)}.`
        : 'This number already belongs to an associate of another CPM.',
    );
  }
}

async function codeTaken(companyId: number, code: string, selfId?: number) {
  const other = await p.associate.findFirst({
    where: {
      company_id: companyId,
      associate_code: code,
      ...(selfId ? { id: { not: selfId } } : {}),
    },
  });
  if (other) throw new AppError(409, `The code ${code} already belongs to another associate.`);
}

const cleanCode = (v: string | null | undefined) => (v ? v.trim().toUpperCase() || null : null);

export async function createAssociate(user: TokenPayload, body: AssociateInput) {
  const companyId = user.companyId;
  const phone = tenDigits(body.phone);
  if (!/^\d{10}$/.test(phone)) throw new AppError(400, 'Enter a 10-digit mobile number');
  await phoneTaken(user, companyId, phone);
  const code = cleanCode(body.associate_code);
  if (code) await codeTaken(companyId, code);
  const pipeline = body.pipeline || (code ? 'ENROLLED' : 'INVITED');
  const owner =
    body.owner_cpm_id !== undefined
      ? await checkOwner(user, companyId, body.owner_cpm_id)
      : seesAllAssociates(user)
        ? null
        : user.employeeId;
  const created = await p.associate.create({
    data: {
      company_id: companyId,
      full_name: body.full_name!.trim(),
      phone,
      associate_code: code,
      email: body.email?.trim() || null,
      designation: body.designation?.trim() || null,
      upline_id: await checkUpline(companyId, null, body.upline_id ?? null),
      owner_cpm_id: owner,
      pipeline,
      enrolled_at: pipeline === 'ENROLLED' ? new Date() : null,
      notes: body.notes?.trim() || null,
      next_follow_up_at: body.next_follow_up_at ? parseDay(body.next_follow_up_at) : null,
      source: 'MANUAL',
      created_by_id: user.employeeId,
    },
  });
  return created;
}

export async function updateAssociate(user: TokenPayload, id: number, body: AssociateInput) {
  const a = await getInScope(user, id);
  const data: Prisma.AssociateUncheckedUpdateInput = {};
  if (body.full_name !== undefined) data.full_name = body.full_name.trim();
  if (body.phone !== undefined) {
    const phone = tenDigits(body.phone);
    if (!/^\d{10}$/.test(phone)) throw new AppError(400, 'Enter a 10-digit mobile number');
    await phoneTaken(user, a.company_id, phone, a.id);
    data.phone = phone;
  }
  if (body.associate_code !== undefined) {
    const code = cleanCode(body.associate_code);
    if (code) await codeTaken(a.company_id, code, a.id);
    data.associate_code = code;
  }
  if (body.email !== undefined) data.email = body.email?.trim() || null;
  if (body.designation !== undefined) data.designation = body.designation?.trim() || null;
  if (body.notes !== undefined) data.notes = body.notes?.trim() || null;
  if (body.upline_id !== undefined)
    data.upline_id = await checkUpline(a.company_id, a.id, body.upline_id);
  if (body.owner_cpm_id !== undefined && body.owner_cpm_id !== a.owner_cpm_id) {
    data.owner_cpm_id = await checkOwner(user, a.company_id, body.owner_cpm_id);
  }
  if (body.next_follow_up_at !== undefined) {
    data.next_follow_up_at = body.next_follow_up_at ? parseDay(body.next_follow_up_at) : null;
  }
  if (body.pipeline !== undefined && body.pipeline !== a.pipeline) {
    data.pipeline = body.pipeline;
    data.pipeline_changed_at = new Date();
    if (body.pipeline === 'ENROLLED' && !a.enrolled_at) data.enrolled_at = new Date();
  }
  return p.associate.update({ where: { id: a.id }, data });
}

export async function listCpms(user: TokenPayload) {
  const companyIds = await getAccessibleCompanyIds(user);
  return p.employee.findMany({
    where: {
      company_id: { in: companyIds },
      status: 'ACTIVE',
      roles: { some: { role: { name: Roles.CHANNEL_PARTNER_MANAGER } } },
    },
    select: { id: true, full_name: true, employee_code: true },
    orderBy: { full_name: 'asc' },
  });
}

export async function getAssociate(user: TokenPayload, id: number) {
  const a = await getInScope(user, id);
  const all = seesAllAssociates(user);
  const [owner, upline, downline, leads, followUps, credential] = await Promise.all([
    a.owner_cpm_id
      ? p.employee.findUnique({
          where: { id: a.owner_cpm_id },
          select: { id: true, full_name: true },
        })
      : null,
    a.upline_id
      ? p.associate.findUnique({
          where: { id: a.upline_id },
          select: { id: true, full_name: true, associate_code: true },
        })
      : null,
    p.associate.count({ where: { upline_id: a.id } }),
    p.lead.findMany({
      where: { associate_id: a.id },
      select: {
        id: true,
        lead_code: true,
        customer_name: true,
        phone: true,
        status: true,
        created_at: true,
        assigned_to_id: true,
        created_by_id: true,
        project: { select: { name: true } },
        assigned_to: { select: { full_name: true } },
      },
      orderBy: { created_at: 'desc' },
      take: 200,
    }),
    p.associateFollowUp.findMany({
      where: { associate_id: a.id },
      select: {
        id: true,
        channel: true,
        outcome: true,
        notes: true,
        next_follow_up_at: true,
        created_at: true,
        employee: { select: { full_name: true } },
      },
      orderBy: { created_at: 'desc' },
      take: 30,
    }),
    p.associateCredential.findUnique({
      where: { associate_id: a.id },
      select: { force_password_change: true, last_login_at: true },
    }),
  ]);
  const last = await lastActivity(leads.map((l) => l.id));
  return {
    associate: { ...a, owner, upline, downline_count: downline },
    // A CPM sees the customer's number only on leads they own or added:
    // whether staff may call an associate's customer is the owner's call.
    leads: leads.map(({ phone, assigned_to_id, created_by_id, ...l }) => {
      const own = all || assigned_to_id === user.employeeId || created_by_id === user.employeeId;
      const la = last.get(l.id);
      return {
        ...l,
        phone: own ? phone : maskPhone(phone),
        open: !CLOSED_LEAD.includes(l.status),
        last_update: la && la > l.created_at ? la : l.created_at,
      };
    }),
    follow_ups: followUps,
    office_visits: await officeVisitsOf(a.id),
    portal: {
      enabled: associatePortalEnabled(),
      has_login: !!credential,
      must_change_password: credential?.force_password_change ?? null,
      last_login_at: credential?.last_login_at ?? null,
    },
  };
}

export const associatePortalEnabled = () => process.env.ASSOCIATE_PORTAL_ENABLED === 'true';

// ---- Follow-ups ----

/** Next follow-up when none is given: a day for a missed call, a week after a talk. */
const NEXT_DAYS: Record<string, number> = {
  REACHED: 7,
  AGREED: 2, // send the form, then check it is filled
  THINKING: 3,
  DECLINED: 30, // not closed: one more try in a month
  HAS_LEAD: 1, // add the lead
  WANTS_VISIT: 1, // book the visit
  NO_UPDATE: 7,
};
function suggestNext(outcome: string, now: Date) {
  if (outcome === 'WRONG_NUMBER') return null;
  return dayStart(new Date(now.getTime() + (NEXT_DAYS[outcome] ?? 1) * DAY));
}

export async function logFollowUp(
  user: TokenPayload,
  id: number,
  body: { outcome: string; channel?: string; notes?: string; next_follow_up_at?: string | null },
) {
  const a = await getInScope(user, id);
  const now = new Date();
  const channel = body.channel || 'CALL';
  // Each answer fits one kind of associate: someone not yet joined, or someone who has.
  if (PROSPECT_OUTCOMES.includes(body.outcome) && !PROSPECT_STAGES.includes(a.pipeline)) {
    throw new AppError(400, 'That answer is for someone who has not joined yet.');
  }
  if (JOINED_OUTCOMES.includes(body.outcome) && !LOGIN_STAGES.includes(a.pipeline)) {
    throw new AppError(400, 'That answer is for an associate who has joined.');
  }
  const next =
    body.next_follow_up_at === undefined
      ? suggestNext(body.outcome, now)
      : body.next_follow_up_at
        ? parseDay(body.next_follow_up_at)
        : null;
  const reached = SPOKE_OUTCOMES.includes(body.outcome) || channel !== 'CALL';
  const data: Prisma.AssociateUncheckedUpdateInput = { next_follow_up_at: next };
  if (reached) data.last_contacted_at = now;
  // The first real conversation moves a new prospect on.
  if (reached && a.pipeline === 'INVITED') {
    data.pipeline = 'CONTACTED';
    data.pipeline_changed_at = now;
  }
  // "Agreed to work with us": the next step is the onboarding form.
  if (body.outcome === 'AGREED' && ['INVITED', 'CONTACTED'].includes(a.pipeline)) {
    data.pipeline = 'AGREED';
    data.pipeline_changed_at = now;
  }
  const [followUp] = await p.$transaction([
    p.associateFollowUp.create({
      data: {
        company_id: a.company_id,
        associate_id: a.id,
        employee_id: user.employeeId,
        channel,
        outcome: body.outcome,
        notes: body.notes?.trim() || null,
        next_follow_up_at: next,
      },
    }),
    p.associate.update({ where: { id: a.id }, data }),
  ]);
  return { follow_up: followUp, next_follow_up_at: next };
}

// ---- Lead status reported by the associate ----

export async function reportLeadStatus(
  user: TokenPayload,
  associateId: number,
  leadId: number,
  report: string,
  note?: string,
) {
  const a = await getInScope(user, associateId);
  const lead = await p.lead.findFirst({ where: { id: leadId, associate_id: a.id } });
  if (!lead) throw new AppError(404, 'This lead is not linked to this associate');
  const me = await p.employee.findUnique({
    where: { id: user.employeeId },
    select: { full_name: true, employee_code: true },
  });
  const by = `${label(a)} reported via ${me?.full_name || me?.employee_code || 'CPM'}`;
  const what = REPORTS[report];
  let status = lead.status;
  let result: 'APPLIED' | 'NOTED' | 'NEEDS_REVIEW' = 'NOTED';
  let reason = '';
  const applied: string[] = [];

  // Through the normal lead rules (workflow guards included). The CPM is
  // allowed because the lead belongs to an associate in their scope, which
  // was checked above; they are usually not the lead's owner.
  const move = async (to: string) => {
    await updateLeadStatus(user, lead.id, to, `${what}, ${by}`, undefined, {
      skipPermissionCheck: true,
    });
    applied.push(to);
    status = to;
  };

  try {
    if (CLOSED_LEAD.includes(lead.status) && report !== 'NO_CHANGE' && report !== 'CANNOT_REACH') {
      result = 'NEEDS_REVIEW';
      reason = `The CRM has this lead as ${lead.status}.`;
    } else if (report === 'CUSTOMER_SPOKE' || report === 'INTERESTED') {
      if (status === 'NEW') {
        result = 'NEEDS_REVIEW';
        reason = 'The lead is not assigned to anyone yet.';
      } else {
        if (status === 'ASSIGNED') await move('CONTACTED');
        if (report === 'INTERESTED' && status === 'CONTACTED') {
          try {
            await move('QUALIFIED');
          } catch (e: any) {
            reason = 'Not qualified yet: budget, property type and location are needed first.';
          }
        }
        result = applied.length ? 'APPLIED' : 'NOTED';
      }
    } else if (report === 'VISITED') {
      if (status === 'SITE_VISIT_SCHEDULED') {
        await move('SITE_VISIT_COMPLETED');
        result = 'APPLIED';
      } else if (rank(status) >= rank('SITE_VISIT_COMPLETED')) {
        result = 'NOTED';
      } else {
        result = 'NEEDS_REVIEW';
        reason = 'There is no site visit on record for this lead.';
      }
    } else if (['WANTS_VISIT', 'NEGOTIATING', 'NOT_INTERESTED', 'BOOKED'].includes(report)) {
      // Never automatic: a visit needs a booking, a deal a value, a drop a
      // reason, and a booking real payments.
      result = 'NEEDS_REVIEW';
      reason = 'The lead owner needs to confirm this and update the lead.';
    }
  } catch (e: any) {
    if (!e?.statusCode) throw e;
    result = 'NEEDS_REVIEW';
    reason = e.message;
  }

  const outcome =
    result === 'APPLIED'
      ? `Stage moved to ${applied.join(', then ')}.`
      : result === 'NEEDS_REVIEW'
        ? `Needs review: ${reason}`
        : reason || 'Stage unchanged.';
  await p.leadActivity.create({
    data: {
      lead_id: lead.id,
      actor_id: user.employeeId,
      activity_type: ASSOCIATE_REPORT_ACTIVITY,
      notes: `${by}: ${what}${note?.trim() ? ` - ${note.trim()}` : ''}. ${outcome}`,
    },
  });
  await p.associate.update({ where: { id: a.id }, data: { last_contacted_at: new Date() } });
  if (result === 'NEEDS_REVIEW' && lead.assigned_to_id && lead.assigned_to_id !== user.employeeId) {
    notifyEmployee(lead.assigned_to_id, {
      type: 'ASSOCIATE_REPORT_REVIEW',
      title: `Check lead ${lead.lead_code}`,
      message: `${by}: ${what}. Please confirm and update the lead.`,
      link: '/leads-clients',
    }).catch((err) => logger.error('[Associates] review notice:', err));
  }
  return { result, applied_stages: applied, status, reason: reason || null };
}

// ---- Today's queue ----

const REASON_ORDER = ['DUE', 'STALE_LEAD', 'QUIET', 'PROSPECT'];

export async function getQueue(
  user: TokenPayload,
  opts: { limit?: number } = {},
  now = new Date(),
) {
  const scope = await associateScope(user);
  const list = await p.associate.findMany({
    where: { AND: [scope, { pipeline: { not: 'LEFT' } }] },
    select: SUMMARY_SELECT,
    take: 5000,
  });
  const start = dayStart(now);
  const end = new Date(start.getTime() + DAY);
  const ids = list.map((a) => a.id);
  const [settings, leads, touched, mine] = await Promise.all([
    settingsFor([...new Set(list.map((a) => a.company_id))]),
    openLeadSilence(ids),
    ids.length
      ? p.associateFollowUp.findMany({
          where: { associate_id: { in: ids }, created_at: { gte: start, lt: end } },
          select: { associate_id: true },
          distinct: ['associate_id'],
        })
      : [],
    p.associateFollowUp.findMany({
      where: { employee_id: user.employeeId, created_at: { gte: start, lt: end } },
      select: { channel: true, outcome: true },
    }),
  ]);
  const touchedToday = new Set(touched.map((t) => t.associate_id));
  const byAssociate = new Map<number, typeof leads>();
  for (const l of leads)
    byAssociate.set(l.associate_id, [...(byAssociate.get(l.associate_id) || []), l]);
  const days = (d: Date) => Math.floor((now.getTime() - d.getTime()) / DAY);

  const rows = [];
  for (const a of list) {
    const s = settings.get(a.company_id) || DEFAULT_SETTINGS;
    const open = byAssociate.get(a.id) || [];
    const reasons: { code: string; label: string }[] = [];
    if (a.next_follow_up_at && a.next_follow_up_at < end) {
      reasons.push({
        code: 'DUE',
        label: a.next_follow_up_at < start ? 'Call was due earlier' : 'Call due today',
      });
    }
    // Followed up today already: only a promised call-back keeps them on.
    if (!touchedToday.has(a.id)) {
      const scheduled = !!a.next_follow_up_at && a.next_follow_up_at >= end;
      const stale = open.filter((l) => days(l.last_update) >= s.stale_days);
      if (stale.length) {
        reasons.push({
          code: 'STALE_LEAD',
          label: `${stale.length} lead${stale.length === 1 ? '' : 's'} with no news for ${s.stale_days}+ days`,
        });
      }
      if (!scheduled) {
        const newest = open.reduce<Date | null>(
          (m, l) => (!m || l.last_update > m ? l.last_update : m),
          null,
        );
        if (newest && days(newest) >= s.quiet_days) {
          reasons.push({
            code: 'QUIET',
            label: `No news on their leads for ${days(newest)} days`,
          });
        }
        if (
          PROSPECT_STAGES.includes(a.pipeline) &&
          (!a.last_contacted_at || now.getTime() - a.last_contacted_at.getTime() >= DAY)
        ) {
          reasons.push({
            code: 'PROSPECT',
            label:
              a.pipeline === 'INVITED'
                ? 'New, not spoken to yet'
                : a.pipeline === 'AGREED'
                  ? 'Agreed: send them the form'
                  : 'Ready to join',
          });
        }
      }
    }
    if (!reasons.length) continue;
    const oldest = open.reduce<Date | null>(
      (m, l) => (!m || l.last_update < m ? l.last_update : m),
      null,
    );
    rows.push({
      ...a,
      open_leads: open.length,
      oldest_silence_days: oldest ? days(oldest) : null,
      reasons,
      _rank: REASON_ORDER.indexOf(reasons[0].code),
    });
  }
  rows.sort(
    (x, y) => x._rank - y._rank || (y.oldest_silence_days ?? -1) - (x.oldest_silence_days ?? -1),
  );
  const limit = Math.min(Math.max(opts.limit || 60, 1), 500);
  return {
    date: getISTComponents(now).dateString,
    total: rows.length,
    today: {
      calls: mine.filter((m) => m.channel === 'CALL').length,
      reached: mine.filter((m) => m.outcome === 'REACHED').length,
      follow_ups: mine.length,
    },
    rows: rows.slice(0, limit).map(({ _rank, ...r }) => r),
  };
}

// ---- Weekly numbers (data only; the reports screens are built elsewhere) ----

export async function weeklyNumbers(user: TokenPayload, dateStr?: string) {
  const ref = /^\d{4}-\d{2}-\d{2}$/.test(dateStr || '')
    ? getISTMidnightInstant(dateStr!)
    : dayStart(new Date());
  const weekday = new Date(ref.getTime() + 5.5 * 60 * 60 * 1000).getUTCDay();
  const from = new Date(ref.getTime() - ((weekday + 6) % 7) * DAY);
  const to = new Date(from.getTime() + 7 * DAY);
  const range = { gte: from, lt: to };
  const scope = await associateScope(user);
  const companyIds = await getAccessibleCompanyIds(user);
  const all = seesAllAssociates(user);

  const [followUps, enrolled, dormant, newLeads, openLeads] = await Promise.all([
    p.associateFollowUp.findMany({
      where: {
        company_id: { in: companyIds },
        created_at: range,
        ...(all ? {} : { employee_id: user.employeeId }),
      },
      select: { employee_id: true, associate_id: true, outcome: true, channel: true },
    }),
    p.associate.findMany({
      where: { AND: [scope, { enrolled_at: range }] },
      select: { owner_cpm_id: true },
    }),
    p.associate.groupBy({
      by: ['owner_cpm_id'],
      where: { AND: [scope, { pipeline: 'DORMANT' }] },
      _count: { _all: true },
    }),
    p.lead.findMany({
      where: { created_at: range, associate: { is: scope } },
      select: { associate_id: true },
    }),
    p.lead.groupBy({
      by: ['associate_id'],
      where: { status: { notIn: CLOSED_LEAD }, associate: { is: scope } },
      _count: { _all: true },
    }),
  ]);

  type Row = {
    employee_id: number | null;
    calls_attempted: number;
    calls_reached: number;
    associates_contacted: number;
    follow_ups: number;
    enrolled: number;
    dormant: number;
  };
  const rows = new Map<number | null, Row & { reached: Set<number> }>();
  const row = (id: number | null) => {
    if (!rows.has(id))
      rows.set(id, {
        employee_id: id,
        calls_attempted: 0,
        calls_reached: 0,
        associates_contacted: 0,
        follow_ups: 0,
        enrolled: 0,
        dormant: 0,
        reached: new Set(),
      });
    return rows.get(id)!;
  };
  for (const f of followUps) {
    const r = row(f.employee_id);
    r.follow_ups++;
    if (f.channel === 'CALL') r.calls_attempted++;
    if (SPOKE_OUTCOMES.includes(f.outcome)) {
      if (f.channel === 'CALL') r.calls_reached++;
      r.reached.add(f.associate_id);
    }
  }
  for (const e of enrolled) row(e.owner_cpm_id).enrolled++;
  for (const d of dormant) row(d.owner_cpm_id).dormant += d._count._all;

  const names = new Map(
    (
      await p.employee.findMany({
        where: { id: { in: [...rows.keys()].filter((k): k is number => k !== null) } },
        select: { id: true, full_name: true },
      })
    ).map((e) => [e.id, e.full_name]),
  );

  const newBy = new Map<number, number>();
  for (const l of newLeads) newBy.set(l.associate_id!, (newBy.get(l.associate_id!) || 0) + 1);
  const openBy = new Map(openLeads.map((o) => [o.associate_id!, o._count._all]));
  const leadIds = [...new Set([...newBy.keys(), ...openBy.keys()])];
  const people = await p.associate.findMany({
    where: { id: { in: leadIds } },
    select: { id: true, full_name: true, associate_code: true },
  });
  const perAssociate = people
    .map((a) => ({ ...a, new_leads: newBy.get(a.id) || 0, open_leads: openBy.get(a.id) || 0 }))
    .sort((x, y) => y.new_leads - x.new_leads || y.open_leads - x.open_leads);

  const byCpm = [...rows.values()].map(({ reached, ...r }) => ({
    ...r,
    name: r.employee_id ? names.get(r.employee_id) || null : 'Not assigned',
    associates_contacted: reached.size,
  }));
  const sum = (k: keyof Row) => byCpm.reduce((n, r) => n + (r[k] as number), 0);
  return {
    week_start: getISTComponents(from).dateString,
    week_end: getISTComponents(new Date(to.getTime() - DAY)).dateString,
    totals: {
      calls_attempted: sum('calls_attempted'),
      calls_reached: sum('calls_reached'),
      associates_contacted: new Set(
        followUps.filter((f) => SPOKE_OUTCOMES.includes(f.outcome)).map((f) => f.associate_id),
      ).size,
      enrolled: sum('enrolled'),
      dormant: sum('dormant'),
      new_leads: newLeads.length,
      associates_with_new_leads: newBy.size,
      new_leads_per_associate: newBy.size ? +(newLeads.length / newBy.size).toFixed(2) : 0,
    },
    by_cpm: byCpm,
    leads_per_associate: perAssociate.slice(0, 100),
  };
}

// ---- Linking leads to associates ----

type AssocKey = { id: number; associate_code: string | null; phone: string };

/** Code first, then exact phone; never by name. Two different answers: no link. */
export function matchAssociate(
  byCode: Map<string, AssocKey>,
  byPhone: Map<string, AssocKey>,
  code: string | null | undefined,
  phone: string | null | undefined,
): { associate?: AssocKey; by?: 'code' | 'phone'; conflict?: boolean } {
  const c = code ? byCode.get(code.trim().toUpperCase()) : undefined;
  const d = tenDigits(phone);
  const ph = d.length === 10 ? byPhone.get(d) : undefined;
  if (c && ph && c.id !== ph.id) return { conflict: true };
  if (c) return { associate: c, by: 'code' };
  if (ph) return { associate: ph, by: 'phone' };
  return {};
}

/** For a new CPM lead: the associate it came from, if exactly one matches. */
export async function associateIdForNewLead(
  companyId: number,
  code: string | null | undefined,
  phone: string | null | undefined,
) {
  const d = tenDigits(phone);
  const or: Prisma.AssociateWhereInput[] = [];
  if (code?.trim()) or.push({ associate_code: code.trim().toUpperCase() });
  if (d.length === 10) or.push({ phone: d });
  if (!or.length) return null;
  const found = await p.associate.findMany({
    where: { company_id: companyId, OR: or },
    select: { id: true, associate_code: true, phone: true },
  });
  const m = matchAssociate(
    new Map(found.filter((f) => f.associate_code).map((f) => [f.associate_code!, f])),
    new Map(found.map((f) => [f.phone, f])),
    code,
    phone,
  );
  return m.associate?.id ?? null;
}

/** A first lead makes an enrolled (or dormant) associate active. */
export async function markActive(ids: number[]) {
  if (!ids.length) return;
  await p.associate.updateMany({
    where: { id: { in: ids }, pipeline: { in: ['ENROLLED', 'DORMANT'] } },
    data: { pipeline: 'ACTIVE', pipeline_changed_at: new Date() },
  });
}

export async function backfillLeads(user: TokenPayload, dryRun: boolean) {
  const companyId = user.companyId;
  const all = seesAllAssociates(user);
  const assocs = await p.associate.findMany({
    where: {
      company_id: companyId,
      ...(all ? {} : { OR: [{ owner_cpm_id: user.employeeId }, { owner_cpm_id: null }] }),
    },
    select: { id: true, associate_code: true, phone: true, full_name: true },
  });
  const byCode = new Map(assocs.filter((a) => a.associate_code).map((a) => [a.associate_code!, a]));
  const byPhone = new Map(assocs.map((a) => [a.phone, a]));
  const leads = await p.lead.findMany({
    where: {
      company_id: companyId,
      associate_id: null,
      OR: [{ external_agent_phone: { not: null } }, { external_agent_associate_id: { not: null } }],
    },
    select: {
      id: true,
      lead_code: true,
      customer_name: true,
      external_agent_name: true,
      external_agent_phone: true,
      external_agent_associate_id: true,
      created_by_id: true,
    },
    take: 20000,
  });
  const names = new Map(assocs.map((a) => [a.id, a]));
  const linked: any[] = [];
  const unmatched: any[] = [];
  const conflicts: any[] = [];
  for (const l of leads) {
    const m = matchAssociate(
      byCode,
      byPhone,
      l.external_agent_associate_id,
      l.external_agent_phone,
    );
    const visible = all || l.created_by_id === user.employeeId;
    const agent = {
      lead_id: l.id,
      lead_code: l.lead_code,
      agent_name: l.external_agent_name,
      agent_phone: l.external_agent_phone,
      agent_code: l.external_agent_associate_id,
    };
    if (m.conflict) {
      if (visible)
        conflicts.push({
          ...agent,
          reason: 'The code and the phone point to two different associates',
        });
    } else if (m.associate) {
      const a = names.get(m.associate.id)!;
      linked.push({
        lead_id: l.id,
        lead_code: l.lead_code,
        customer_name: l.customer_name,
        associate_id: a.id,
        associate_name: a.full_name,
        associate_code: a.associate_code,
        matched_by: m.by,
      });
    } else if (visible) unmatched.push(agent);
  }
  if (!dryRun && linked.length) {
    const groups = new Map<number, number[]>();
    for (const l of linked)
      groups.set(l.associate_id, [...(groups.get(l.associate_id) || []), l.lead_id]);
    for (const [associateId, leadIds] of groups) {
      // associate_id still empty: a second run (or a lead linked meanwhile) changes nothing.
      await p.lead.updateMany({
        where: { id: { in: leadIds }, associate_id: null },
        data: { associate_id: associateId },
      });
    }
    await markActive([...groups.keys()]);
  }
  return {
    dry_run: dryRun,
    linked_count: linked.length,
    unmatched_count: unmatched.length,
    conflict_count: conflicts.length,
    linked: linked.slice(0, 200),
    unmatched: unmatched.slice(0, 200),
    conflicts: conflicts.slice(0, 100),
  };
}

// ---- ACTIVE / DORMANT, and leads past the escalation limit (jobs) ----

export async function refreshPipelines(now = new Date()) {
  const rows = await p.associate.findMany({
    where: { pipeline: { in: LOGIN_STAGES } },
    select: { id: true, company_id: true, pipeline: true, pipeline_changed_at: true },
  });
  if (!rows.length) return 0;
  const leads = await p.lead.findMany({
    where: { associate_id: { in: rows.map((r) => r.id) } },
    select: { id: true, associate_id: true, created_at: true },
  });
  const acts = await lastActivity(leads.map((l) => l.id));
  const touch = new Map<number, Date>();
  for (const l of leads) {
    const t = acts.get(l.id) && acts.get(l.id)! > l.created_at ? acts.get(l.id)! : l.created_at;
    const cur = touch.get(l.associate_id!);
    if (!cur || t > cur) touch.set(l.associate_id!, t);
  }
  const settings = await settingsFor([...new Set(rows.map((r) => r.company_id))]);
  const toActive: number[] = [];
  const toDormant: number[] = [];
  for (const r of rows) {
    const limit = (settings.get(r.company_id) || DEFAULT_SETTINGS).dormant_days * DAY;
    const last = touch.get(r.id);
    const recent = !!last && now.getTime() - last.getTime() <= limit;
    if (r.pipeline === 'ENROLLED' && last) (recent ? toActive : toDormant).push(r.id);
    else if (r.pipeline === 'ACTIVE') {
      const base = last && last > r.pipeline_changed_at ? last : r.pipeline_changed_at;
      if (now.getTime() - base.getTime() > limit) toDormant.push(r.id);
    } else if (r.pipeline === 'DORMANT' && recent && last! > r.pipeline_changed_at)
      toActive.push(r.id);
  }
  if (toActive.length)
    await p.associate.updateMany({
      where: { id: { in: toActive } },
      data: { pipeline: 'ACTIVE', pipeline_changed_at: now },
    });
  if (toDormant.length)
    await p.associate.updateMany({
      where: { id: { in: toDormant } },
      data: { pipeline: 'DORMANT', pipeline_changed_at: now },
    });
  return toActive.length + toDormant.length;
}

/** Associate leads silent past each company's escalation limit. */
export async function leadsPastEscalation(now = new Date()) {
  const assocs = await p.associate.findMany({
    where: { pipeline: { not: 'LEFT' }, leads: { some: { status: { notIn: CLOSED_LEAD } } } },
    select: {
      id: true,
      company_id: true,
      full_name: true,
      associate_code: true,
      owner_cpm_id: true,
    },
  });
  const settings = await settingsFor([...new Set(assocs.map((a) => a.company_id))]);
  const byId = new Map(assocs.map((a) => [a.id, a]));
  const leads = await openLeadSilence(assocs.map((a) => a.id));
  return leads
    .map((l) => {
      const a = byId.get(l.associate_id)!;
      const days = Math.floor((now.getTime() - l.last_update.getTime()) / DAY);
      return { associate: a, lead: l, days, limit: settings.get(a.company_id)!.escalate_days };
    })
    .filter((x) => x.days >= x.limit);
}

// ---- Associate app login, set by the CPM (only while the app is switched on) ----

const TEMP_PASSWORD_HOURS = 72;
export const ASSOCIATE_PASSWORD_RULE = /^(?=.*[A-Za-z])(?=.*\d).{8,64}$/;

export async function setPortalPassword(user: TokenPayload, id: number, password?: string) {
  const a = await getInScope(user, id);
  if (!LOGIN_STAGES.includes(a.pipeline)) {
    throw new AppError(400, 'Only an enrolled associate can have a login.');
  }
  if (password && !ASSOCIATE_PASSWORD_RULE.test(password)) {
    throw new AppError(400, 'Use at least 8 characters with letters and numbers');
  }
  const temp = password || `${crypto.randomBytes(4).toString('hex')}${crypto.randomInt(10, 99)}`;
  const expires = new Date(Date.now() + TEMP_PASSWORD_HOURS * 60 * 60 * 1000);
  const data = {
    password_hash: await bcrypt.hash(temp, 12),
    force_password_change: true,
    temp_password_expiry: expires,
    set_by_id: user.employeeId,
  };
  await p.associateCredential.upsert({
    where: { associate_id: a.id },
    create: { associate_id: a.id, ...data },
    update: data,
  });
  return {
    temporary_password: password ? undefined : temp,
    expires_at: expires,
    login_phone: a.phone,
  };
}
