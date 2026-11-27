import { prisma } from '../../lib/prisma';
import { TokenPayload } from '../../utils/jwt';
import { getISTComponents } from '../../utils/time';
import { notifyEmployee } from '../../utils/notifyEmployee';
import { logger } from '../../utils/logger';
import { AppError } from './errors';
import { activeContactedLeads } from './masterLeadReturn';
import { moveLeadsKeepingStage } from './handoverMove';
import { notExternalPartner } from '../../authz/dataScope';

export type BatchKind = 'uncalled' | 'contacted';

const p = prisma;

// Only leads nobody has called yet are moved: once a telecaller has spoken to
// a customer the lead's history belongs with them.
const MOVABLE_STATUSES = ['NEW', 'ASSIGNED'];
const notCalled = { activities: { none: { activity_type: 'CALL_LOGGED' } } };

const istDayRange = (day: string) => {
  const start = new Date(`${day}T00:00:00+05:30`);
  if (Number.isNaN(start.getTime())) throw new AppError(400, 'Invalid date');
  return { gte: start, lt: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
};

/** Leads with anyone but `employeeId` (or with no one yet). */
const notWith = (employeeId: number) => ({
  OR: [{ assigned_to_id: { not: employeeId } }, { assigned_to_id: null }],
});

/**
 * Not-yet-called leads grouped by upload: who added them, from which source,
 * on which (IST) day, and who has them now. Either the leads sitting with one
 * employee (`employeeId`), or the leads one person uploaded that ended up
 * with someone else (`uploaderId`) -- e.g. an upload sent to the pool by
 * mistake instead of "Assign to Me".
 */
export async function listUploadBatches(
  user: TokenPayload,
  filter: { employeeId?: number; uploaderId?: number },
  kind: BatchKind = 'uncalled',
) {
  if (kind === 'contacted' && !filter.employeeId) {
    throw new AppError(400, 'Choose whose contacted leads to list');
  }
  const leads = await p.lead.findMany({
    where:
      kind === 'contacted'
        ? { company_id: user.companyId, ...activeContactedLeads(filter.employeeId as number) }
        : {
            company_id: user.companyId,
            status: { in: MOVABLE_STATUSES },
            ...notCalled,
            ...(filter.uploaderId
              ? { created_by_id: filter.uploaderId, ...notWith(filter.uploaderId) }
              : { assigned_to_id: filter.employeeId }),
          },
    select: {
      status: true,
      created_at: true,
      source: true,
      created_by_id: true,
      created_by: { select: { full_name: true, employee_code: true } },
      assigned_to: { select: { full_name: true, employee_code: true } },
    },
  });

  const batches = new Map<
    string,
    {
      created_by_id: number | null;
      created_by_name: string;
      source: string;
      day: string;
      count: number;
      holders: Record<string, number>;
      by_stage: Record<string, number>;
    }
  >();
  for (const l of leads) {
    const day = getISTComponents(l.created_at).dateString;
    const key = `${l.created_by_id ?? 0}|${l.source}|${day}`;
    let b = batches.get(key);
    if (!b) {
      b = {
        created_by_id: l.created_by_id,
        created_by_name:
          l.created_by?.full_name || l.created_by?.employee_code || 'Website / system',
        source: l.source,
        day,
        count: 0,
        holders: {},
        by_stage: {},
      };
      batches.set(key, b);
    }
    b.count += 1;
    b.by_stage[l.status] = (b.by_stage[l.status] || 0) + 1;
    const holder = l.assigned_to?.full_name || l.assigned_to?.employee_code || 'Not assigned';
    b.holders[holder] = (b.holders[holder] || 0) + 1;
  }
  return [...batches.values()].sort((a, b) => b.day.localeCompare(a.day) || b.count - a.count);
}

/** Moves one upload batch's not-yet-called leads to another employee: all, or the oldest `count`. */
export async function moveUploadBatch(
  user: TokenPayload,
  input: {
    /** null: from everyone except the target (with created_by_id set). */
    from_employee_id: number | null;
    to_employee_id: number;
    created_by_id: number | null;
    source: string;
    day: string;
    reason: string;
    count?: number;
    kind?: BatchKind;
    /** contacted only: ignore uploader/source/day and take from the person's whole book. */
    whole_book?: boolean;
  },
) {
  if (input.kind === 'contacted') return moveContactedLeads(user, input);
  if (input.from_employee_id === input.to_employee_id) {
    throw new AppError(400, 'Pick a different person to move the leads to');
  }
  if (input.from_employee_id === null && input.created_by_id === null) {
    throw new AppError(400, 'Choose whose leads to move');
  }
  const target = await p.employee.findFirst({
    where: {
      id: input.to_employee_id,
      company_id: user.companyId,
      status: 'ACTIVE',
      ...notExternalPartner,
    },
    select: { id: true, full_name: true, employee_code: true },
  });
  if (!target) throw new AppError(404, 'Employee to move the leads to was not found');

  const leads = await p.lead.findMany({
    where: {
      company_id: user.companyId,
      ...(input.from_employee_id !== null
        ? { assigned_to_id: input.from_employee_id }
        : { AND: [notWith(input.to_employee_id), notWith(input.created_by_id as number)] }),
      created_by_id: input.created_by_id,
      source: input.source,
      created_at: istDayRange(input.day),
      status: { in: MOVABLE_STATUSES },
      ...notCalled,
    },
    select: { id: true },
    orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    ...(input.count ? { take: input.count } : {}),
  });
  if (leads.length === 0) throw new AppError(404, 'No uncalled leads left in this batch');

  const ids = leads.map((l) => l.id);
  const targetName = target.full_name || target.employee_code;
  const now = new Date();

  await p.$transaction(async (tx) => {
    await tx.lead.updateMany({
      where: { id: { in: ids } },
      data: {
        assigned_to_id: target.id,
        assigned_at: now,
        assignment_type: 'MANUAL_OVERRIDE',
        status: 'ASSIGNED',
      },
    });
    await tx.leadActivity.createMany({
      data: ids.map((id) => ({
        lead_id: id,
        actor_id: user.employeeId,
        activity_type: 'ASSIGNED_TO_AGENT',
        notes: `Moved with its upload batch to ${targetName}. Reason: ${input.reason}`,
      })),
    });
    await tx.auditEvent.create({
      data: {
        actor_id: user.employeeId,
        action: 'LEAD_BATCH_REASSIGNED',
        entity_type: 'EMPLOYEE',
        entity_id: input.from_employee_id ?? input.created_by_id ?? 0,
        old_value: JSON.stringify({ assigned_to_id: input.from_employee_id }),
        new_value: JSON.stringify({ ...input, lead_ids: ids }),
      },
    });
    await tx.notification.create({
      data: {
        employee_id: target.id,
        type: 'TARGET_ASSIGNED',
        title: `${ids.length} leads assigned to you`,
        message: `${ids.length} leads were moved to you. Reason: ${input.reason}`,
      },
    });
  });

  notifyEmployee(
    target.id,
    {
      type: 'TARGET_ASSIGNED',
      title: `${ids.length} leads assigned to you`,
      message: `${ids.length} leads were moved to you.`,
    },
    { skipDbNotification: true },
  ).catch((err) => logger.error('[WebPush] Lead batch move:', err));

  return { moved: ids.length, to: targetName };
}

/** Totals by stage over a list of batches, e.g. "12 Contacted, 5 Qualified". */
export function stageTotals(batches: Array<{ by_stage: Record<string, number> }>) {
  const totals: Record<string, number> = {};
  for (const b of batches) {
    for (const [stage, n] of Object.entries(b.by_stage)) totals[stage] = (totals[stage] || 0) + n;
  }
  return totals;
}

/**
 * Hand over a person's CONTACTED and ACTIVE leads (see activeContactedLeads) by
 * count, e.g. a leaver's book split between several people one move after
 * another. Leads keep their stage, call-backs, visits, opportunities and
 * history; the first owner keeps credit when they have left. Leads that cannot
 * move are skipped and reported, never failing the batch.
 */
async function moveContactedLeads(
  user: TokenPayload,
  input: {
    from_employee_id: number | null;
    to_employee_id: number;
    created_by_id: number | null;
    source: string;
    day: string;
    reason: string;
    count?: number;
    whole_book?: boolean;
  },
) {
  if (input.from_employee_id === null) throw new AppError(400, 'Choose whose leads to move');
  if (input.from_employee_id === input.to_employee_id) {
    throw new AppError(400, 'Pick a different person to move the leads to');
  }
  const fromId = input.from_employee_id;
  const [from, target] = await Promise.all([
    p.employee.findFirst({
      where: { id: fromId, company_id: user.companyId },
      select: {
        id: true,
        full_name: true,
        employee_code: true,
        status: true,
        resignation_date: true,
      },
    }),
    p.employee.findFirst({
      where: {
        id: input.to_employee_id,
        company_id: user.companyId,
        status: 'ACTIVE',
        ...notExternalPartner,
      },
      select: { id: true, full_name: true, employee_code: true, company_id: true },
    }),
  ]);
  if (!from) throw new AppError(404, 'Employee to move the leads from was not found');
  if (!target) throw new AppError(404, 'Employee to move the leads to was not found');

  const leads = await p.lead.findMany({
    where: {
      company_id: user.companyId,
      ...activeContactedLeads(fromId),
      ...(input.whole_book
        ? {}
        : {
            created_by_id: input.created_by_id,
            source: input.source,
            created_at: istDayRange(input.day),
          }),
    },
    orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    ...(input.count ? { take: input.count } : {}),
  });
  if (leads.length === 0) throw new AppError(404, 'No contacted active leads left to move');

  const fromName = from.full_name || from.employee_code;
  const targetName = target.full_name || target.employee_code;
  const leaver = from.status === 'RESIGNED' || !!from.resignation_date;
  const tally = await moveLeadsKeepingStage(
    leads,
    target,
    user,
    {
      action: 'LEAD_HANDED_OVER',
      note: `Handed over from ${fromName} to ${targetName}. Reason: ${input.reason}`,
      reason: input.reason,
    },
    leaver ? fromId : null,
  );

  await p.auditEvent
    .create({
      data: {
        actor_id: user.employeeId,
        action: 'LEAD_BATCH_REASSIGNED',
        entity_type: 'EMPLOYEE',
        entity_id: fromId,
        old_value: JSON.stringify({ assigned_to_id: fromId }),
        new_value: JSON.stringify({
          kind: 'contacted',
          to_employee_id: target.id,
          reason: input.reason,
          requested: input.count ?? null,
          moved: tally.leads,
          by_stage: tally.by_stage,
          skipped: tally.left + tally.failed,
        }),
      },
    })
    .catch((err) => logger.error('[handover] batch audit:', err));

  if (tally.leads > 0) {
    await notifyEmployee(target.id, {
      type: 'TARGET_ASSIGNED',
      title: `${tally.leads} lead${tally.leads === 1 ? '' : 's'} handed over to you`,
      message: `${tally.leads} contacted lead${tally.leads === 1 ? '' : 's'} from ${fromName} are now yours, with their stage and history. Reason: ${input.reason}`,
      link: '/leads',
    }).catch((err) => logger.error('[handover] notify failed:', err));
  }

  return {
    moved: tally.leads,
    to: targetName,
    by_stage: tally.by_stage,
    skipped: tally.left + tally.failed,
    skipped_other_company: tally.left,
    skipped_failed: tally.failed,
  };
}
