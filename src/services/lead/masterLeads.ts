import { prisma } from '../../lib/prisma';
import { TokenPayload } from '../../utils/jwt';
import { getISTComponents } from '../../utils/time';
import { notifyEmployee } from '../../utils/notifyEmployee';
import { logger } from '../../utils/logger';
import { Roles, DO_NOT_CALL_EXIT_REASONS } from '../../shared';
import { AppError } from './errors';

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

export async function startBatch(
  user: TokenPayload,
  input: { file_name: string; file_size?: number; source?: string; source_detail?: string },
) {
  return p.masterLeadBatch.create({
    data: {
      company_id: user.companyId,
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
      batch_id: batchId,
      phone,
      name: text(row.customer_name ?? row.name, 100) || null,
      email: text(row.email, 120).toLowerCase() || null,
      location: text(row.location, 100) || null,
      notes: text(row.notes, 255) || null,
    });
  }

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
  const [batches, telecallers] = await Promise.all([
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
  const [left, assignedToday, followUps] = await Promise.all([
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
    p.task.groupBy({
      by: ['assignee_id'],
      where: {
        assignee_id: { in: ids },
        lead_id: { not: null },
        target_date: { lt: new Date(today.getTime() + 24 * 3600 * 1000) },
        status: { notIn: ['COMPLETED', 'CANCELLED', 'NOT_COMPLETED', 'BLOCKED'] },
      },
      _count: { _all: true },
    }),
  ]);

  const added = batches.reduce((n, b) => n + b.added, 0);
  const assigned = batches.reduce((n, b) => n + b.assigned_count, 0);
  const skipped = batches.reduce((n, b) => n + b.skipped_count, 0);

  return {
    totals: { added, assigned, skipped, unassigned: Math.max(0, added - assigned - skipped) },
    batches: batches.map(batchView),
    telecallers: telecallers.map((t) => {
      const mine = left.filter((l) => l.assigned_to_id === t.id);
      return {
        ...t,
        assigned_today: assignedToday.find((a) => a.assigned_to_id === t.id)?._count._all || 0,
        left: mine.length,
        overdue: mine.filter((l) => !l.assigned_at || l.assigned_at < today).length,
        follow_ups_due: followUps.find((f) => f.assignee_id === t.id)?._count._all || 0,
      };
    }),
  };
}

/** Moves up to `count` of the oldest unassigned numbers to one telecaller. */
async function assignTo(
  user: TokenPayload,
  employee: { id: number },
  count: number,
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
           WHERE company_id = ? AND status = 'NEW' ${batchId ? 'AND batch_id = ?' : ''}
           ORDER BY id LIMIT ? FOR UPDATE`,
          ...(batchId ? [user.companyId, batchId, step] : [user.companyId, step]),
        );
        if (rows.length < step) empty = true;
        if (!rows.length) return;

        // A number can become a lead after it was uploaded (website, Facebook...).
        const existing = await tx.lead.findMany({
          where: { company_id: user.companyId, phone: { in: rows.map((r) => r.phone) } },
          select: { phone: true, id: true, status: true, exit_reason: true },
        });
        const existingBy = new Map(existing.map((l) => [l.phone, l]));
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
                source_detail: b?.source_detail || null,
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
          const idByCode = new Map(leads.map((l) => [l.lead_code, l.id]));
          for (const r of fresh) {
            await tx.masterLead.update({
              where: { id: Number(r.id) },
              data: {
                status: 'ASSIGNED',
                lead_id: idByCode.get(leadCodeFor(Number(r.id))),
                assigned_to_id: employee.id,
                assigned_at: now,
              },
            });
          }
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

export async function assignDaily(
  user: TokenPayload,
  input: { batch_id?: number; assignments: { employee_id: number; count: number }[] },
) {
  for (const a of input.assignments) {
    if (a.count > MAX_PER_PERSON) {
      throw new AppError(400, `At most ${MAX_PER_PERSON} numbers per person at a time`);
    }
  }
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
    const r = await assignTo(user, employee, a.count, input.batch_id);
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
      new_value: JSON.stringify({ results, skipped }),
    },
  });
  return { results, skipped };
}

/**
 * Uncalled numbers go back to master data. Only leads nothing has happened on are
 * removed; anything with a call, task, visit or opportunity stays with the person.
 */
export async function takeBack(user: TokenPayload, employeeId: number) {
  const leads = await p.lead.findMany({
    where: {
      company_id: user.companyId,
      ...uncalledAssigned(employeeId),
      follow_up_tasks: { none: {} },
      site_visits: { none: {} },
      opportunities: { none: {} },
    },
    select: { id: true, lead_code: true },
  });
  if (!leads.length) return { returned: 0 };

  const ids = leads.map((l) => l.id);
  await p.$transaction(
    async (tx) => {
      const masters = await tx.masterLead.findMany({
        where: { lead_id: { in: ids } },
        select: { id: true, batch_id: true },
      });
      await tx.masterLead.updateMany({
        where: { id: { in: masters.map((m) => m.id) } },
        data: { status: 'NEW', lead_id: null, assigned_to_id: null, assigned_at: null },
      });
      for (const batchId of new Set(masters.map((m) => m.batch_id))) {
        await tx.masterLeadBatch.update({
          where: { id: batchId },
          data: {
            assigned_count: { decrement: masters.filter((m) => m.batch_id === batchId).length },
          },
        });
      }
      await tx.lead.deleteMany({ where: { id: { in: ids } } });
      await tx.auditEvent.create({
        data: {
          actor_id: user.employeeId,
          action: 'MASTER_LEADS_TAKEN_BACK',
          entity_type: 'EMPLOYEE',
          entity_id: employeeId,
          new_value: JSON.stringify({ lead_codes: leads.map((l) => l.lead_code) }),
        },
      });
    },
    { timeout: 30_000 },
  );
  return { returned: ids.length };
}
