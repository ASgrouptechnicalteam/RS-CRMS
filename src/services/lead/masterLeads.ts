import { prisma } from '../../lib/prisma';
import { TokenPayload } from '../../utils/jwt';
import { getISTComponents } from '../../utils/time';
import { notifyEmployee } from '../../utils/notifyEmployee';
import { logger } from '../../utils/logger';
import { Roles, DO_NOT_CALL_EXIT_REASONS } from '../../shared';
import { AppError } from './errors';
import { followUpsDue } from '../counts/followUps';

const p = prisma;

export const DAILY_ASSIGNMENT = 'DAILY_ASSIGNMENT';
export const MAX_ROWS_PER_REQUEST = 2000;
const MAX_PER_PERSON = 1000;
// Small steps: each is one short database transaction, on a shared database.
const ASSIGN_STEP = 200;

const leadCodeFor = (masterId: number) => `RRH-LD-M${masterId}`;
const text = (v: unknown, max: number) =>
  v === undefined || v === null ? '' : String(v).trim().slice(0, max);

/** 10-digit Indian mobile number, or null. */
export const cleanPhone = (raw: unknown): string | null => {
  let phone = text(raw, 20).replace(/\.0+$/, '').replace(/\D/g, '');
  if (phone.length === 12 && phone.startsWith('91')) phone = phone.slice(2);
  if (phone.length === 11 && phone.startsWith('0')) phone = phone.slice(1);
  return /^[6-9]\d{9}$/.test(phone) ? phone : null;
};

const dayStart = (d = new Date()) => new Date(`${getISTComponents(d).dateString}T00:00:00+05:30`);

/** Assigned by the Technical Manager and not called yet: what blocks logout. */
export const uncalledAssigned = (employeeId: number) => ({
  assigned_to_id: employeeId,
  assignment_type: DAILY_ASSIGNMENT,
  status: { in: ['NEW', 'ASSIGNED'] },
  activities: { none: { activity_type: 'CALL_LOGGED' } },
});

const activeGroup = async (user: TokenPayload, groupId: number) => {
  const group = await p.masterLeadGroup.findFirst({
    where: { id: groupId, company_id: user.companyId, is_active: true },
  });
  if (!group) throw new AppError(404, 'That group was not found');
  return group;
};

const isDuplicateKey = (e: unknown) => (e as { code?: string })?.code === 'P2002';

export async function createGroup(user: TokenPayload, input: { name: string }) {
  const name = text(input.name, 80);
  if (name.length < 2) throw new AppError(400, 'Enter a group name');
  try {
    return await p.masterLeadGroup.create({
      data: { company_id: user.companyId, name, created_by_id: user.employeeId },
    });
  } catch (e) {
    if (isDuplicateKey(e)) throw new AppError(409, 'A group with this name already exists');
    throw e;
  }
}

/** Rename, or retire a group. A retired group keeps its numbers but takes no new work. */
export async function updateGroup(
  user: TokenPayload,
  groupId: number,
  input: { name?: string; is_active?: boolean },
) {
  const group = await p.masterLeadGroup.findFirst({
    where: { id: groupId, company_id: user.companyId },
  });
  if (!group) throw new AppError(404, 'That group was not found');
  const name = input.name === undefined ? undefined : text(input.name, 80);
  if (name !== undefined && name.length < 2) throw new AppError(400, 'Enter a group name');
  try {
    return await p.masterLeadGroup.update({
      where: { id: groupId },
      data: { name, is_active: input.is_active },
    });
  } catch (e) {
    if (isDuplicateKey(e)) throw new AppError(409, 'A group with this name already exists');
    throw e;
  }
}

export async function startBatch(
  user: TokenPayload,
  input: {
    group_id: number;
    file_name: string;
    file_size?: number;
    source?: string;
    source_detail?: string;
  },
) {
  await activeGroup(user, input.group_id);
  return p.masterLeadBatch.create({
    data: {
      company_id: user.companyId,
      group_id: input.group_id,
      file_name: text(input.file_name, 200) || 'Upload',
      file_size: BigInt(Math.max(0, Math.floor(input.file_size || 0))),
      source: text(input.source, 40) || 'BULK_UPLOAD',
      source_detail: text(input.source_detail, 80) || null,
      uploaded_by_id: user.employeeId,
    },
  });
}

const batchFor = async (user: TokenPayload, batchId: number) => {
  const batch = await p.masterLeadBatch.findFirst({
    where: { id: batchId, company_id: user.companyId },
  });
  if (!batch) throw new AppError(404, 'Upload not found');
  return batch;
};

/**
 * One slice of a file. `start_row` must be where the server has got to, so a slice
 * sent twice (a retry after a dropped connection) is never counted twice, and a
 * stopped upload continues from where it stopped.
 */
export async function addRows(
  user: TokenPayload,
  batchId: number,
  input: { start_row: number; rows: Record<string, unknown>[]; done?: boolean },
) {
  if (input.rows.length > MAX_ROWS_PER_REQUEST) {
    throw new AppError(400, `Send at most ${MAX_ROWS_PER_REQUEST} rows at a time`);
  }
  const batch = await batchFor(user, batchId);
  if (batch.completed_at) throw new AppError(409, 'This upload has already finished');
  if (input.start_row !== batch.rows_received) {
    return { accepted: false, rows_received: batch.rows_received };
  }

  let failed = 0;
  const seen = new Set<string>();
  const data: {
    company_id: number;
    group_id: number;
    batch_id: number;
    phone: string;
    name: string | null;
    email: string | null;
    location: string | null;
    notes: string | null;
  }[] = [];
  for (const row of input.rows) {
    const phone = cleanPhone(row.phone);
    if (!phone) {
      failed++;
      continue;
    }
    if (seen.has(phone)) continue; // counted below as a duplicate
    seen.add(phone);
    data.push({
      company_id: user.companyId,
      group_id: batch.group_id,
      batch_id: batchId,
      phone,
      name: text(row.customer_name ?? row.name, 100) || null,
      email: text(row.email, 120).toLowerCase() || null,
      location: text(row.location, 100) || null,
      notes: text(row.notes, 255) || null,
    });
  }

  // First group wins: a number already held stays where it is, and the upload says where.
  const held = data.length
    ? await p.masterLead.findMany({
        where: { company_id: user.companyId, phone: { in: data.map((d) => d.phone) } },
        select: { group_id: true },
      })
    : [];
  const repeats: Record<string, number> = { ...((batch.repeats_by_group as object) || {}) };
  for (const h of held) repeats[h.group_id] = (repeats[h.group_id] || 0) + 1;

  const created = data.length
    ? (await p.masterLead.createMany({ data, skipDuplicates: true })).count
    : 0;
  const updated = await p.masterLeadBatch.update({
    where: { id: batchId },
    data: {
      rows_received: { increment: input.rows.length },
      added: { increment: created },
      failed: { increment: failed },
      duplicates: { increment: input.rows.length - failed - created },
      repeats_by_group: repeats,
      ...(input.done ? { completed_at: new Date() } : {}),
    },
  });
  return {
    accepted: true,
    rows_received: updated.rows_received,
    added: updated.added,
    duplicates: updated.duplicates,
    failed: updated.failed,
  };
}

const batchView = (b: any) => ({ ...b, file_size: Number(b.file_size) });

/** Totals from the upload counters (never a count over the whole table). */
export async function getOverview(user: TokenPayload) {
  const today = dayStart();
  const [groups, batches, telecallers] = await Promise.all([
    p.masterLeadGroup.findMany({
      where: { company_id: user.companyId },
      orderBy: { name: 'asc' },
    }),
    p.masterLeadBatch.findMany({
      where: { company_id: user.companyId },
      orderBy: { created_at: 'desc' },
    }),
    p.employee.findMany({
      where: {
        company_id: user.companyId,
        status: 'ACTIVE',
        roles: { some: { role: { name: Roles.TELECALLER } } },
      },
      select: { id: true, employee_code: true, full_name: true },
      orderBy: { full_name: 'asc' },
    }),
  ]);

  const ids = telecallers.map((t) => t.id);
  const [left, assignedToday, due] = await Promise.all([
    p.lead.findMany({
      where: {
        company_id: user.companyId,
        assigned_to_id: { in: ids },
        assignment_type: DAILY_ASSIGNMENT,
        status: { in: ['NEW', 'ASSIGNED'] },
        activities: { none: { activity_type: 'CALL_LOGGED' } },
      },
      select: { assigned_to_id: true, assigned_at: true },
    }),
    p.lead.groupBy({
      by: ['assigned_to_id'],
      where: {
        company_id: user.companyId,
        assigned_to_id: { in: ids },
        assignment_type: DAILY_ASSIGNMENT,
        assigned_at: { gte: today },
      },
      _count: { _all: true },
    }),
    followUpsDue(ids, user.companyId),
  ]);

  const totalsFor = (rows: typeof batches) => {
    const added = rows.reduce((n, b) => n + b.added, 0);
    const assigned = rows.reduce((n, b) => n + b.assigned_count, 0);
    const skipped = rows.reduce((n, b) => n + b.skipped_count, 0);
    return { added, assigned, skipped, unassigned: Math.max(0, added - assigned - skipped) };
  };

  return {
    totals: totalsFor(batches),
    groups: groups.map((g) => ({
      id: g.id,
      name: g.name,
      is_active: g.is_active,
      ...totalsFor(batches.filter((b) => b.group_id === g.id)),
    })),
    batches: batches.map(batchView),
    telecallers: telecallers.map((t) => {
      const mine = left.filter((l) => l.assigned_to_id === t.id);
      return {
        ...t,
        assigned_today: assignedToday.find((a) => a.assigned_to_id === t.id)?._count._all || 0,
        left: mine.length,
        overdue: mine.filter((l) => !l.assigned_at || l.assigned_at < today).length,
        follow_ups_due: due.get(t.id)?.total || 0,
      };
    }),
  };
}

/** The usual ways one mobile number gets typed into a lead, for an indexed exact match. */
const phoneForms = (phone: string) => [
  phone,
  `91${phone}`,
  `+91${phone}`,
  `+91 ${phone}`,
  `0${phone}`,
  `${phone.slice(0, 5)} ${phone.slice(5)}`,
  `+91 ${phone.slice(0, 5)} ${phone.slice(5)}`,
];

/** Moves up to `count` of the oldest unassigned numbers in one group to one telecaller. */
async function assignTo(
  user: TokenPayload,
  employee: { id: number },
  count: number,
  group: { id: number; name: string },
  batchId?: number,
) {
  let given = 0;
  let skipped = 0;
  let empty = false;
  const now = new Date();

  while (given < count && !empty) {
    const step = Math.min(ASSIGN_STEP, count - given);
    await p.$transaction(
      async (tx) => {
        // Locked, so two people assigning at once can never get the same numbers.
        const rows = await tx.$queryRawUnsafe<
          {
            id: number;
            batch_id: number;
            phone: string;
            name: string | null;
            email: string | null;
            location: string | null;
            notes: string | null;
          }[]
        >(
          `SELECT id, batch_id, phone, name, email, location, notes FROM MasterLead
           WHERE company_id = ? AND group_id = ? AND status = 'NEW' ${batchId ? 'AND batch_id = ?' : ''}
           ORDER BY id LIMIT ? FOR UPDATE`,
          ...(batchId
            ? [user.companyId, group.id, batchId, step]
            : [user.companyId, group.id, step]),
        );
        if (rows.length < step) empty = true;
        if (!rows.length) return;

        // A number can become a lead after it was uploaded (website, Facebook...).
        const existing = await tx.lead.findMany({
          where: {
            company_id: user.companyId,
            phone: { in: rows.flatMap((r) => phoneForms(r.phone)) },
          },
          select: { phone: true, id: true, status: true, exit_reason: true },
        });
        const existingBy = new Map(existing.map((l) => [cleanPhone(l.phone), l]));
        const fresh = rows.filter((r) => !existingBy.has(r.phone));
        const stale = rows.filter((r) => existingBy.has(r.phone));

        const batchIds = [...new Set(rows.map((r) => Number(r.batch_id)))];
        const batches = await tx.masterLeadBatch.findMany({ where: { id: { in: batchIds } } });
        const batchBy = new Map(batches.map((b) => [b.id, b]));

        if (fresh.length) {
          await tx.lead.createMany({
            data: fresh.map((r) => {
              const b = batchBy.get(Number(r.batch_id));
              return {
                lead_code: leadCodeFor(Number(r.id)),
                company_id: user.companyId,
                customer_name: r.name || 'Unknown',
                phone: r.phone,
                email: r.email,
                preferred_location: r.location,
                notes: r.notes,
                source: b?.source || 'BULK_UPLOAD',
                // The group name, so reports can tell government data from housing leads.
                source_detail: b?.source_detail || group.name,
                status: 'ASSIGNED',
                assigned_to_id: employee.id,
                assigned_at: now,
                assignment_type: DAILY_ASSIGNMENT,
                created_by_id: b?.uploaded_by_id ?? user.employeeId,
              };
            }),
          });
          const leads = await tx.lead.findMany({
            where: { lead_code: { in: fresh.map((r) => leadCodeFor(Number(r.id))) } },
            select: { id: true, lead_code: true },
          });
          await tx.leadActivity.createMany({
            data: leads.map((l) => ({
              lead_id: l.id,
              actor_id: user.employeeId,
              activity_type: 'ASSIGNED_TO_AGENT',
              notes: 'Assigned from master data for the day',
            })),
          });
          const freshIds = fresh.map((r) => Number(r.id));
          // One statement for the step: a row-by-row loop is what makes big days slow.
          await tx.$executeRawUnsafe(
            `UPDATE MasterLead m JOIN Lead l ON l.lead_code = CONCAT('RRH-LD-M', m.id)
             SET m.status = 'ASSIGNED', m.lead_id = l.id, m.assigned_to_id = ?, m.assigned_at = ?,
                 m.last_assignee_id = ?, m.times_assigned = m.times_assigned + 1
             WHERE m.id IN (${freshIds.map(() => '?').join(',')})`,
            employee.id,
            now,
            employee.id,
            ...freshIds,
          );
          await tx.masterLeadEvent.createMany({
            data: freshIds.map((id) => ({
              company_id: user.companyId,
              master_lead_id: id,
              group_id: group.id,
              employee_id: employee.id,
              event: 'ASSIGNED',
              by_id: user.employeeId,
            })),
          });
        }
        for (const r of stale) {
          const lead = existingBy.get(r.phone)!;
          const doNotCall =
            !!lead.exit_reason && (DO_NOT_CALL_EXIT_REASONS as string[]).includes(lead.exit_reason);
          await tx.masterLead.update({
            where: { id: Number(r.id) },
            data: { status: doNotCall ? 'DO_NOT_CALL' : 'ALREADY_LEAD', lead_id: lead.id },
          });
        }
        for (const id of batchIds) {
          await tx.masterLeadBatch.update({
            where: { id },
            data: {
              assigned_count: {
                increment: fresh.filter((r) => Number(r.batch_id) === id).length,
              },
              skipped_count: {
                increment: stale.filter((r) => Number(r.batch_id) === id).length,
              },
            },
          });
        }
        given += fresh.length;
        skipped += stale.length;
      },
      { timeout: 30_000 },
    );
  }
  return { given, skipped, empty };
}

type AssignInput = {
  request_id: string;
  group_id: number;
  batch_id?: number;
  assignments: { employee_id: number; count: number }[];
};

export async function assignDaily(user: TokenPayload, input: AssignInput) {
  for (const a of input.assignments) {
    if (a.count > MAX_PER_PERSON) {
      throw new AppError(400, `At most ${MAX_PER_PERSON} numbers per person at a time`);
    }
  }
  const group = await activeGroup(user, input.group_id);

  let run: { id: number };
  try {
    run = await p.masterLeadAssignRun.create({
      data: { request_id: input.request_id, company_id: user.companyId, by_id: user.employeeId },
    });
  } catch (e) {
    if (!isDuplicateKey(e)) throw e;
    const earlier = await p.masterLeadAssignRun.findUnique({
      where: { request_id: input.request_id },
    });
    if (earlier?.company_id === user.companyId && earlier.status === 'DONE') {
      return earlier.result as unknown as Awaited<ReturnType<typeof runAssign>>;
    }
    throw new AppError(
      409,
      earlier?.status === 'FAILED'
        ? 'That assignment stopped part-way. Check the counts below, then assign the rest.'
        : 'That assignment is still running. Check the counts below in a minute.',
    );
  }

  try {
    const result = await runAssign(user, input, group);
    await p.masterLeadAssignRun.update({
      where: { id: run.id },
      data: { status: 'DONE', result },
    });
    return result;
  } catch (e) {
    await p.masterLeadAssignRun.update({ where: { id: run.id }, data: { status: 'FAILED' } });
    throw e;
  }
}

async function runAssign(
  user: TokenPayload,
  input: AssignInput,
  group: { id: number; name: string },
) {
  const employees = await p.employee.findMany({
    where: {
      id: { in: input.assignments.map((a) => a.employee_id) },
      company_id: user.companyId,
      status: 'ACTIVE',
      roles: { some: { role: { name: Roles.TELECALLER } } },
    },
    select: { id: true, full_name: true, employee_code: true },
  });

  const results: { employee_id: number; name: string; given: number; asked: number }[] = [];
  let skipped = 0;
  for (const a of input.assignments) {
    const employee = employees.find((e) => e.id === a.employee_id);
    if (!employee) throw new AppError(404, 'That telecaller was not found or has left');
    const r = await assignTo(user, employee, a.count, group, input.batch_id);
    skipped += r.skipped;
    results.push({
      employee_id: employee.id,
      name: employee.full_name || employee.employee_code,
      given: r.given,
      asked: a.count,
    });
    if (r.given > 0) {
      const message = `${r.given} new numbers to call today. Please finish them before you log out.`;
      await p.notification.create({
        data: {
          employee_id: employee.id,
          type: 'TARGET_ASSIGNED',
          title: `${r.given} calls assigned for today`,
          message,
        },
      });
      notifyEmployee(
        employee.id,
        { type: 'TARGET_ASSIGNED', title: `${r.given} calls assigned for today`, message },
        { skipDbNotification: true },
      ).catch((err) => logger.error('[WebPush] Daily assignment:', err));
    }
  }

  await p.auditEvent.create({
    data: {
      actor_id: user.employeeId,
      action: 'MASTER_LEADS_ASSIGNED',
      entity_type: 'MASTER_LEAD_BATCH',
      entity_id: input.batch_id ?? 0,
      new_value: JSON.stringify({ group_id: group.id, results, skipped }),
    },
  });
  return { results, skipped };
}

// ---- Looking inside one group (MD and Admin only; read only, no export) ----

export const CONTACT_STATUSES = ['NEW', 'ASSIGNED', 'ALREADY_LEAD', 'DO_NOT_CALL'] as const;

/**
 * One page of the people in a group, oldest first, 50 at a time by default.
 * `after` is the last id of the previous page (cheap on a very large group);
 * `q` matches the start of a phone number or of a name. Opening the first page is
 * written to the audit trail, since these are customer phone numbers.
 */
export async function listGroupContacts(
  user: TokenPayload,
  groupId: number,
  opts: { after?: number; limit?: number; q?: string; status?: string },
) {
  const group = await p.masterLeadGroup.findFirst({
    where: { id: groupId, company_id: user.companyId },
    select: { id: true, name: true, is_active: true },
  });
  if (!group) throw new AppError(404, 'That group was not found');

  const limit = Math.min(Math.max(Math.floor(opts.limit || 50), 1), 100);
  const status = (CONTACT_STATUSES as readonly string[]).includes(opts.status || '')
    ? (opts.status as string)
    : undefined;
  const q = text(opts.q, 40);
  const digits = q.replace(/\D/g, '');

  const base = { company_id: user.companyId, group_id: groupId };
  const where: Record<string, unknown> = { ...base };
  if (status) where.status = status;
  if (q) {
    where.OR = [
      ...(digits.length >= 3 ? [{ phone: { startsWith: digits } }] : []),
      { name: { startsWith: q } },
    ];
  }
  if (opts.after) where.id = { gt: Math.floor(opts.after) };

  const [rows, counts] = await Promise.all([
    p.masterLead.findMany({
      where,
      orderBy: { id: 'asc' },
      take: limit + 1,
      select: {
        id: true,
        phone: true,
        name: true,
        email: true,
        location: true,
        notes: true,
        status: true,
        assigned_to_id: true,
        assigned_at: true,
        returned_at: true,
        times_assigned: true,
        batch_id: true,
      },
    }),
    opts.after
      ? Promise.resolve(null)
      : p.masterLead.groupBy({ by: ['status'], where: base, _count: { _all: true } }),
  ]);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const staffIds = [...new Set(page.map((r) => r.assigned_to_id).filter((x): x is number => !!x))];
  const batchIds = [...new Set(page.map((r) => r.batch_id))];
  const [staff, batches] = await Promise.all([
    staffIds.length
      ? p.employee.findMany({
          where: { id: { in: staffIds }, company_id: user.companyId },
          select: { id: true, full_name: true, employee_code: true },
        })
      : Promise.resolve([]),
    p.masterLeadBatch.findMany({
      where: { id: { in: batchIds }, company_id: user.companyId },
      select: { id: true, file_name: true },
    }),
  ]);
  const staffName = new Map(staff.map((s) => [s.id, s.full_name || s.employee_code]));
  const fileName = new Map(batches.map((b) => [b.id, b.file_name]));

  if (!opts.after) {
    await p.auditEvent
      .create({
        data: {
          actor_id: user.employeeId!,
          action: 'VIEW_MASTER_GROUP_CONTACTS',
          entity_type: 'MASTER_LEAD_GROUP',
          entity_id: groupId,
          new_value: JSON.stringify({ group: group.name, status: status || 'ALL', search: !!q }),
        },
      })
      .catch((err: unknown) => logger.error('Could not record the master group view:', err));
  }

  const byStatus: Record<string, number> = {};
  for (const row of counts || []) byStatus[row.status] = row._count._all;

  return {
    group,
    counts: counts ? byStatus : undefined,
    has_more: hasMore,
    next_after: hasMore ? page[page.length - 1].id : null,
    contacts: page.map((r) => ({
      id: r.id,
      phone: r.phone,
      name: r.name,
      email: r.email,
      location: r.location,
      notes: r.notes,
      status: r.status,
      times_assigned: r.times_assigned,
      assigned_at: r.assigned_at,
      returned_at: r.returned_at,
      assigned_to: r.assigned_to_id
        ? { id: r.assigned_to_id, name: staffName.get(r.assigned_to_id) || 'Former employee' }
        : null,
      file_name: fileName.get(r.batch_id) || null,
    })),
  };
}

// ---- Moving one uploaded file to another group ----

/** Rows moved per call: small enough that the shared database is never held for long. */
export const MOVE_STEP_ROWS = 20000;

/**
 * Moves every number of one upload (a batch) to another group, for an upload that went
 * into the wrong group. Numbers already given to telecallers move too, so the group
 * totals stay right; the leads themselves are not touched. Call it again with the same
 * arguments until `done` is true: each call moves one slice, and the upload's own group
 * is switched only after its last number moved, so an interrupted move can be resumed.
 */
export async function moveBatchToGroup(
  user: TokenPayload,
  batchId: number,
  targetGroupId: number,
  stepRows = MOVE_STEP_ROWS,
) {
  const batch = await p.masterLeadBatch.findFirst({
    where: { id: batchId, company_id: user.companyId },
  });
  if (!batch) throw new AppError(404, 'That upload was not found');
  if (!batch.completed_at) {
    throw new AppError(409, 'This upload has not finished. Finish or continue it first.');
  }
  const target = await activeGroup(user, targetGroupId);
  const from = await p.masterLeadGroup.findFirst({
    where: { id: batch.group_id, company_id: user.companyId },
    select: { id: true, name: true },
  });

  const moved = await p.$executeRaw`
    UPDATE MasterLead SET group_id = ${target.id}
    WHERE company_id = ${user.companyId} AND batch_id = ${batch.id} AND group_id <> ${target.id}
    LIMIT ${stepRows}`;

  const left = await p.masterLead.count({
    where: { company_id: user.companyId, batch_id: batch.id, group_id: { not: target.id } },
  });
  if (left > 0) return { done: false, moved, left, group: target };

  if (batch.group_id !== target.id) {
    await p.masterLeadBatch.update({ where: { id: batch.id }, data: { group_id: target.id } });
    await p.auditEvent
      .create({
        data: {
          actor_id: user.employeeId!,
          action: 'MASTER_BATCH_MOVED',
          entity_type: 'MASTER_LEAD_BATCH',
          entity_id: batch.id,
          new_value: JSON.stringify({
            file: batch.file_name,
            from_group: from?.name ?? batch.group_id,
            to_group: target.name,
            numbers: batch.added,
          }),
        },
      })
      .catch((err: unknown) => logger.error('Could not record the master upload move:', err));
  }
  return { done: true, moved, left: 0, group: target };
}
