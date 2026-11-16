import { prisma } from '../../lib/prisma';
import { TokenPayload } from '../../utils/jwt';
import { getISTComponents } from '../../utils/time';
import { AppError } from './errors';
import { cleanPhone } from './masterLeads';
import { ACTIVE_STATUSES } from './telecallerReport';

const p = prisma;

const OPEN = { notIn: ['BOOKED', 'DROPPED'] };
// One short transaction per request; the screen sends requests until `done`.
const RETURN_STEP = 100;

/**
 * Leads nothing has happened on. The single definition of "not contacted", used by the
 * return to master data and by the contacted-only hand-over. A no-answer call counts as
 * contact (owner's decision, 2026-11-07), so that lead goes to a person, never back.
 */
const untouchedConditions = {
  status: { in: ['NEW', 'ASSIGNED'] },
  last_contacted_at: null,
  previous_lead_id: null,
  activities: { none: { activity_type: { notIn: ['LEAD_CREATED', 'ASSIGNED_TO_AGENT'] } } },
  follow_up_tasks: { none: {} },
  site_visits: { none: {} },
  demos: { none: {} },
  opportunities: { none: {} },
  property_interests: { none: {} },
  next_leads: { none: {} },
  matching_requirement: { is: null },
  converted_customer: { is: null },
};

export const untouchedLeads = (employeeId: number) => ({
  assigned_to_id: employeeId,
  ...untouchedConditions,
});

/** Open stages: a lead still being worked. Never DROPPED, BOOKED or RECOVERED_TO_POOL. */
export const ACTIVE_LEAD_STATUSES = ACTIVE_STATUSES;

/**
 * ONE definition of what a hand-over moves: the person's ACTIVE leads that were
 * CONTACTED (not untouched). Dropped, booked, recovered-to-pool and untouched
 * leads are never included. Used by "Move leads by count" (contacted) and by
 * the one-shot "Hand over work".
 */
export const activeContactedLeads = (employeeId: number) => ({
  assigned_to_id: employeeId,
  status: { in: ACTIVE_LEAD_STATUSES },
  NOT: untouchedConditions,
});

const employeeFor = async (companyId: number, employeeId: number) => {
  const employee = await p.employee.findFirst({
    where: { id: employeeId, company_id: companyId },
    select: { id: true, full_name: true, employee_code: true, status: true },
  });
  if (!employee) throw new AppError(404, 'Employee not found');
  return employee;
};

/**
 * The leads that can go back to master data. Untouched, with a number master data can
 * hold, and not a number already marked do not call.
 */
export async function findReturnableLeads(employeeId: number) {
  const leads = await p.lead.findMany({
    where: untouchedLeads(employeeId),
    select: { id: true, phone: true, company_id: true },
  });
  const phoneOf = new Map(leads.map((l) => [l.id, cleanPhone(l.phone)]));
  const phones = [...new Set([...phoneOf.values()].filter(Boolean))] as string[];
  const companyIds = [...new Set(leads.map((l) => l.company_id))];
  const rows = phones.length
    ? await p.masterLead.findMany({
        where: { company_id: { in: companyIds }, phone: { in: phones } },
        select: { company_id: true, phone: true, group_id: true, status: true },
      })
    : [];
  const rowOf = new Map(rows.map((r) => [`${r.company_id}:${r.phone}`, r]));
  return leads.flatMap((l) => {
    const phone = phoneOf.get(l.id);
    if (!phone) return [];
    const row = rowOf.get(`${l.company_id}:${phone}`);
    if (row?.status === 'DO_NOT_CALL') return [];
    return [{ id: l.id, company_id: l.company_id, phone, group_id: row?.group_id ?? null }];
  });
}

/** People who hold leads with no stage yet, those who have left first. */
export async function listPeopleForReturn(user: TokenPayload) {
  const held = await p.lead.groupBy({
    by: ['assigned_to_id'],
    where: {
      company_id: user.companyId,
      assigned_to_id: { not: null },
      status: { in: ['NEW', 'ASSIGNED'] },
    },
    _count: { _all: true },
  });
  const employees = await p.employee.findMany({
    where: { id: { in: held.map((h) => h.assigned_to_id!) } },
    select: { id: true, full_name: true, employee_code: true, status: true },
  });
  return employees
    .map((e) => ({
      id: e.id,
      name: e.full_name || e.employee_code,
      code: e.employee_code,
      has_left: e.status !== 'ACTIVE',
      new_leads: held.find((h) => h.assigned_to_id === e.id)?._count._all || 0,
    }))
    .sort((a, b) => Number(b.has_left) - Number(a.has_left) || a.name.localeCompare(b.name));
}

/** What a return would do, so nobody confirms a number they have not seen. */
export async function previewReturn(user: TokenPayload, employeeId: number) {
  const employee = await employeeFor(user.companyId, employeeId);
  const [returnable, open] = await Promise.all([
    findReturnableLeads(employeeId),
    p.lead.count({
      where: { assigned_to_id: employeeId, company_id: user.companyId, status: OPEN },
    }),
  ]);
  const mine = returnable.filter((l) => l.company_id === user.companyId);
  const groups = await p.masterLeadGroup.findMany({
    where: { company_id: user.companyId },
    select: { id: true, name: true },
  });
  const by_group = groups
    .map((g) => ({
      group_id: g.id,
      name: g.name,
      count: mine.filter((l) => l.group_id === g.id).length,
    }))
    .filter((g) => g.count > 0);
  return {
    employee: {
      id: employee.id,
      name: employee.full_name || employee.employee_code,
      has_left: employee.status !== 'ACTIVE',
    },
    open,
    returnable: mine.length,
    stays_for_handover: open - mine.length,
    by_group,
    no_group: mine.filter((l) => l.group_id === null).length,
  };
}

type Input = {
  employee_id: number;
  group_id?: number;
  keep_original: boolean;
  reason?: string;
  after_id?: number;
};

/**
 * One step of a return: at most RETURN_STEP leads in one transaction. Every lead is locked
 * and checked again inside it, so a call logged a moment ago keeps its lead. The Lead row
 * goes (a re-issue must count as a fresh call); the event keeps a full copy of it.
 */
export async function returnToMaster(user: TokenPayload, input: Input) {
  const employee = await employeeFor(user.companyId, input.employee_id);
  const chosen = input.group_id
    ? await p.masterLeadGroup.findFirst({
        where: { id: input.group_id, company_id: user.companyId, is_active: true },
      })
    : null;
  if (input.group_id && !chosen) throw new AppError(404, 'That group was not found');
  if (!input.keep_original && !chosen) throw new AppError(400, 'Choose a group');

  const candidates = await p.lead.findMany({
    where: {
      ...untouchedLeads(employee.id),
      company_id: user.companyId,
      id: { gt: input.after_id || 0 },
    },
    orderBy: { id: 'asc' },
    take: RETURN_STEP,
    select: { id: true },
  });
  if (!candidates.length)
    return { returned: 0, skipped: 0, after_id: input.after_id || 0, done: true };

  const ids = candidates.map((c) => c.id);
  const name = employee.full_name || employee.employee_code;
  const reason = (input.reason || '').trim().slice(0, 200) || null;
  const label = `Returned from ${name} on ${getISTComponents(new Date()).dateString}`.slice(0, 200);

  const outcome = await p.$transaction(
    async (tx) => {
      await tx.$queryRawUnsafe(
        `SELECT id FROM Lead WHERE id IN (${ids.map(() => '?').join(',')}) FOR UPDATE`,
        ...ids,
      );
      const leads = await tx.lead.findMany({
        where: { ...untouchedLeads(employee.id), company_id: user.companyId, id: { in: ids } },
      });
      // Stock held for a customer has no link Prisma can filter on.
      const held = new Set([
        ...(
          await tx.projectUnit.findMany({
            where: { held_for_lead_id: { in: ids } },
            select: { held_for_lead_id: true },
          })
        ).map((u) => u.held_for_lead_id),
        ...(
          await tx.property.findMany({
            where: { held_for_lead_id: { in: ids } },
            select: { held_for_lead_id: true },
          })
        ).map((u) => u.held_for_lead_id),
      ]);

      const phoneOf = new Map(leads.map((l) => [l.id, cleanPhone(l.phone)]));
      const phones = [...new Set([...phoneOf.values()].filter(Boolean))] as string[];
      const rows = await tx.masterLead.findMany({
        where: { company_id: user.companyId, phone: { in: phones } },
      });
      const rowOf = new Map(rows.map((r) => [r.phone, r]));

      const now = new Date();
      const counters = new Map<number, { added: number; assigned: number; skipped: number }>();
      const count = (batchId: number) => {
        if (!counters.has(batchId)) counters.set(batchId, { added: 0, assigned: 0, skipped: 0 });
        return counters.get(batchId)!;
      };
      // One batch per group and source, so per-group totals still add up from batches.
      const returnBatches = new Map<string, number>();
      const returnBatchFor = async (groupId: number, source: string, detail: string | null) => {
        const key = `${groupId}|${source}|${detail}`;
        if (returnBatches.has(key)) return returnBatches.get(key)!;
        const where = { company_id: user.companyId, group_id: groupId, file_name: label, source };
        const batch =
          (await tx.masterLeadBatch.findFirst({ where: { ...where, source_detail: detail } })) ||
          (await tx.masterLeadBatch.create({
            data: {
              ...where,
              source_detail: detail,
              uploaded_by_id: user.employeeId,
              completed_at: now,
            },
          }));
        returnBatches.set(key, batch.id);
        return batch.id;
      };

      const gone: number[] = [];
      for (const lead of leads) {
        const phone = phoneOf.get(lead.id);
        const row = phone ? rowOf.get(phone) : undefined;
        const groupId = input.keep_original ? (row?.group_id ?? chosen?.id) : chosen?.id;
        if (!phone || row?.status === 'DO_NOT_CALL' || !groupId || held.has(lead.id)) continue;

        const source = (lead.source || 'BULK_UPLOAD').slice(0, 40);
        const detail = lead.source_detail || null;
        let masterId: number;
        if (row) {
          const stays = row.group_id === groupId;
          const batchId = stays ? row.batch_id : await returnBatchFor(groupId, source, detail);
          if (row.status === 'ASSIGNED') count(row.batch_id).assigned--;
          if (row.status === 'ALREADY_LEAD') count(row.batch_id).skipped--;
          if (!stays) {
            count(row.batch_id).added--;
            count(batchId).added++;
          }
          await tx.masterLead.update({
            where: { id: row.id },
            data: {
              status: 'NEW',
              group_id: groupId,
              batch_id: batchId,
              lead_id: null,
              assigned_to_id: null,
              assigned_at: null,
              last_assignee_id: employee.id,
              returned_at: now,
            },
          });
          masterId = row.id;
        } else {
          const batchId = await returnBatchFor(groupId, source, detail);
          count(batchId).added++;
          const created = await tx.masterLead.create({
            data: {
              company_id: user.companyId,
              group_id: groupId,
              batch_id: batchId,
              phone,
              name: lead.customer_name === 'Unknown' ? null : lead.customer_name.slice(0, 100),
              email: lead.email?.slice(0, 120) || null,
              location: lead.preferred_location?.slice(0, 100) || null,
              notes: lead.notes?.slice(0, 255) || null,
              last_assignee_id: employee.id,
              returned_at: now,
            },
          });
          rowOf.set(phone, created); // A second lead with this number in the same step.
          masterId = created.id;
        }
        await tx.masterLeadEvent.create({
          data: {
            company_id: user.companyId,
            master_lead_id: masterId,
            group_id: groupId,
            employee_id: employee.id,
            event: 'RETURNED',
            by_id: user.employeeId,
            reason,
            snapshot: JSON.parse(JSON.stringify(lead)),
          },
        });
        gone.push(lead.id);
      }

      for (const [batchId, c] of counters) {
        await tx.masterLeadBatch.update({
          where: { id: batchId },
          data: {
            added: { increment: c.added },
            assigned_count: { increment: c.assigned },
            skipped_count: { increment: c.skipped },
          },
        });
      }
      await tx.lead.deleteMany({ where: { id: { in: gone } } });
      await tx.auditEvent.create({
        data: {
          actor_id: user.employeeId,
          action: 'MASTER_LEADS_RETURNED',
          entity_type: 'EMPLOYEE',
          entity_id: employee.id,
          new_value: JSON.stringify({
            returned: gone.length,
            group_id: chosen?.id ?? null,
            reason,
          }),
        },
      });
      return gone.length;
    },
    { timeout: 60_000 },
  );

  return {
    returned: outcome,
    skipped: ids.length - outcome,
    after_id: ids[ids.length - 1],
    done: ids.length < RETURN_STEP,
  };
}
