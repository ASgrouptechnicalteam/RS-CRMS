import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { TokenPayload } from '../utils/jwt';
import { Roles } from '../shared';
import { AppError } from './lead/errors';
import { associateScope, logFollowUp, seesAllAssociates } from './associate.service';
import { getISTComponents, getISTMidnightInstant } from '../utils/time';
import { notifyEmployee } from '../utils/notifyEmployee';
import { logger } from '../utils/logger';

/**
 * Office visits: an associate (new or old) comes to our office to meet someone. Planned ahead, then marked
 * arrived, done or "did not come". Only the words "office visit" are used on purpose: it must never be
 * confused with a customer's site visit.
 *
 * A DONE office visit is recorded as an office-visit follow-up on the associate, so it counts as the
 * manager's work everywhere (reports, targets, dashboards) without a second entry.
 */
const p = prisma as any;
const DAY = 24 * 60 * 60 * 1000;

export const OFFICE_PURPOSES = ['NEW_ASSOCIATE', 'CATCH_UP', 'OTHER'] as const;
export const OFFICE_STATUSES = ['PLANNED', 'ARRIVED', 'DONE', 'NO_SHOW', 'CANCELLED'] as const;

const dayStart = (d: Date) => getISTMidnightInstant(getISTComponents(d).dateString);

const SELECT = {
  id: true,
  associate_id: true,
  scheduled_at: true,
  purpose: true,
  met_by_id: true,
  status: true,
  arrived_at: true,
  done_at: true,
  notes: true,
  created_by_id: true,
  associate: {
    select: { id: true, full_name: true, phone: true, pipeline: true, associate_code: true },
  },
} satisfies Prisma.AssociateOfficeVisitSelect;

/** Whose office visits a person sees: a manager their own; the MD, Admin and Technical Manager everyone's. */
async function visibleWhere(user: TokenPayload): Promise<Prisma.AssociateOfficeVisitWhereInput> {
  const scope = await associateScope(user);
  const base: Prisma.AssociateOfficeVisitWhereInput = { associate: { is: scope } };
  if (seesAllAssociates(user)) return base;
  return {
    AND: [
      base,
      {
        OR: [
          { met_by_id: user.employeeId },
          { created_by_id: user.employeeId },
          { met_by_id: null },
        ],
      },
    ],
  };
}

async function withNames<T extends { met_by_id: number | null }>(rows: T[]) {
  const ids = [...new Set(rows.map((r) => r.met_by_id).filter((x): x is number => !!x))];
  const people = ids.length
    ? await p.employee.findMany({
        where: { id: { in: ids } },
        select: { id: true, full_name: true },
      })
    : [];
  const name = new Map<number, string | null>(people.map((e: any) => [e.id, e.full_name]));
  return rows.map((r) => ({
    ...r,
    met_by_name: r.met_by_id ? (name.get(r.met_by_id) ?? null) : null,
  }));
}

/** Today's office visits, the next two weeks, and earlier ones nobody has closed yet. */
export async function listOfficeVisits(user: TokenPayload, now = new Date()) {
  const where = await visibleWhere(user);
  const start = dayStart(now);
  const end = new Date(start.getTime() + DAY);
  const [today, upcoming, earlier] = await Promise.all([
    p.associateOfficeVisit.findMany({
      where: { AND: [where, { scheduled_at: { gte: start, lt: end } }] },
      select: SELECT,
      orderBy: { scheduled_at: 'asc' },
    }),
    p.associateOfficeVisit.findMany({
      where: {
        AND: [
          where,
          { scheduled_at: { gte: end, lt: new Date(end.getTime() + 14 * DAY) } },
          { status: { in: ['PLANNED'] } },
        ],
      },
      select: SELECT,
      orderBy: { scheduled_at: 'asc' },
      take: 100,
    }),
    p.associateOfficeVisit.findMany({
      where: {
        AND: [
          where,
          { scheduled_at: { gte: new Date(start.getTime() - 14 * DAY), lt: start } },
          { status: { in: ['PLANNED', 'ARRIVED'] } },
        ],
      },
      select: SELECT,
      orderBy: { scheduled_at: 'desc' },
      take: 100,
    }),
  ]);
  return {
    today: await withNames(today),
    upcoming: await withNames(upcoming),
    earlier_open: await withNames(earlier),
  };
}

export async function planOfficeVisit(
  user: TokenPayload,
  body: {
    associate_id: number;
    scheduled_at: string;
    purpose: string;
    met_by_id?: number | null;
    notes?: string;
  },
) {
  const a = await p.associate.findFirst({
    where: { id: body.associate_id, ...(await associateScope(user)) },
    select: { id: true, company_id: true, full_name: true, owner_cpm_id: true },
  });
  if (!a) throw new AppError(404, 'Associate not found');
  const when = new Date(body.scheduled_at);
  if (Number.isNaN(when.getTime())) throw new AppError(400, 'Enter a valid date and time');
  if (when.getTime() < Date.now() - DAY) {
    throw new AppError(400, 'The office visit cannot be in the past. Choose today or a later day.');
  }
  // A manager plans for themselves; the MD, Admin and Technical Manager choose who will meet the associate.
  const metBy = seesAllAssociates(user)
    ? (body.met_by_id ?? a.owner_cpm_id ?? null)
    : user.employeeId;
  if (metBy) {
    const ok = await p.employee.findFirst({
      where: {
        id: metBy,
        company_id: a.company_id,
        status: 'ACTIVE',
        roles: { some: { role: { name: Roles.CHANNEL_PARTNER_MANAGER } } },
      },
      select: { id: true },
    });
    if (!ok && metBy !== user.employeeId) {
      throw new AppError(400, 'Choose an active Channel Partner Manager.');
    }
  }
  const row = await p.associateOfficeVisit.create({
    data: {
      company_id: a.company_id,
      associate_id: a.id,
      scheduled_at: when,
      purpose: body.purpose,
      met_by_id: metBy,
      notes: body.notes?.trim() || null,
      created_by_id: user.employeeId,
    },
    select: SELECT,
  });
  if (metBy && metBy !== user.employeeId) {
    notifyEmployee(metBy, {
      type: 'ASSOCIATE_OFFICE_VISIT',
      title: 'Office visit planned',
      message: `${a.full_name} is coming to the office on ${when.toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })}.`,
      link: '/associates',
    }).catch((e) => logger.error('[Associates] office visit notice:', e));
  }
  return (await withNames([row]))[0];
}

export async function updateOfficeVisit(
  user: TokenPayload,
  id: number,
  body: { status?: string; notes?: string; scheduled_at?: string },
) {
  const row = await p.associateOfficeVisit.findFirst({
    where: { AND: [await visibleWhere(user), { id }] },
    select: SELECT,
  });
  if (!row) throw new AppError(404, 'Office visit not found');
  const data: Prisma.AssociateOfficeVisitUncheckedUpdateInput = {};
  const now = new Date();

  if (body.scheduled_at !== undefined) {
    if (row.status !== 'PLANNED')
      throw new AppError(400, 'Only a planned office visit can be moved.');
    const when = new Date(body.scheduled_at);
    if (Number.isNaN(when.getTime())) throw new AppError(400, 'Enter a valid date and time');
    data.scheduled_at = when;
  }
  if (body.notes !== undefined) data.notes = body.notes.trim() || null;

  const status = body.status;
  if (status) {
    const open = ['PLANNED', 'ARRIVED'];
    const fail = () => {
      throw new AppError(400, 'This office visit cannot be changed that way.');
    };
    if (status === 'ARRIVED') {
      if (row.status !== 'PLANNED') fail();
      data.status = 'ARRIVED';
      data.arrived_at = now;
    } else if (status === 'DONE') {
      if (!open.includes(row.status)) fail();
      data.status = 'DONE';
      data.done_at = now;
      if (!row.arrived_at) data.arrived_at = now;
    } else if (status === 'NO_SHOW') {
      if (!open.includes(row.status)) fail();
      data.status = 'NO_SHOW';
    } else if (status === 'CANCELLED') {
      if (row.status !== 'PLANNED') fail();
      data.status = 'CANCELLED';
    } else fail();
  }

  const saved = await p.associateOfficeVisit.update({ where: { id }, data, select: SELECT });
  // A finished office visit is the manager's work: it is recorded once, as an office-visit follow-up.
  if (status === 'DONE') {
    await logFollowUp(user, row.associate_id, {
      outcome: 'REACHED',
      channel: 'OFFICE_VISIT',
      notes: [saved.notes, `Office visit on ${getISTComponents(row.scheduled_at).dateString}`]
        .filter(Boolean)
        .join('. ')
        .slice(0, 1000),
    });
  }
  return (await withNames([saved]))[0];
}

/** The latest office visits of one associate, for their details page. */
export async function officeVisitsOf(associateId: number) {
  const rows = await p.associateOfficeVisit.findMany({
    where: { associate_id: associateId },
    select: SELECT,
    orderBy: { scheduled_at: 'desc' },
    take: 10,
  });
  return withNames(rows);
}
