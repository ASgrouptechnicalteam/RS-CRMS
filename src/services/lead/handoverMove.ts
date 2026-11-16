import { Lead, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { TokenPayload } from '../../utils/jwt';
import { logger } from '../../utils/logger';
import { moveLeadOwnership } from './transfer';
import { DAILY_ASSIGNMENT } from './masterLeads';

const p = prisma;

/** Leads moved per transaction, so a big book never holds one long transaction. */
export const LEAD_CHUNK = 50;

export type MoveTally = {
  leads: number;
  call_backs: number;
  opportunities: number;
  visits: number;
  /** Not moved because they belong to another company than the new owner. */
  left: number;
  /** Not moved because something refused (e.g. a workflow guard). */
  failed: number;
  by_stage: Record<string, number>;
};

/**
 * Moves already-chosen leads to one person, keeping stage, call-backs, visits,
 * opportunities, demos and history (moveLeadOwnership). Chunked, each chunk one
 * transaction; a chunk that fails is retried lead by lead so one bad lead is
 * skipped and counted. `leaverId`: the first owner keeps credit for the stage.
 * A lead that was not a daily assignment keeps its assignment type.
 */
export async function moveLeadsKeepingStage(
  leads: Lead[],
  target: { id: number; company_id: number },
  actor: TokenPayload,
  log: { action: string; note: string; reason: string },
  leaverId: number | null,
): Promise<MoveTally> {
  const tally: MoveTally = {
    leads: 0,
    call_backs: 0,
    opportunities: 0,
    visits: 0,
    left: 0,
    failed: 0,
    by_stage: {},
  };

  const moveOne = async (tx: Prisma.TransactionClient, lead: Lead) => {
    const r = await moveLeadOwnership(tx, lead, target.id, actor, log);
    if (lead.assignment_type !== DAILY_ASSIGNMENT) {
      await tx.lead.update({
        where: { id: lead.id },
        data: { assignment_type: lead.assignment_type },
      });
    }
    if (leaverId !== null) {
      // The first owner keeps the credit for the stage the lead had reached with them.
      await tx.lead.updateMany({
        where: { id: lead.id, handed_over_from_id: null },
        data: { handed_over_from_id: leaverId, handover_status: lead.status },
      });
    }
    return r;
  };
  type Moved = Awaited<ReturnType<typeof moveOne>>;
  const count = (lead: Lead, r: Moved) => {
    tally.leads++;
    tally.call_backs += r.movedCallBacks;
    tally.opportunities += r.movedOpportunities;
    tally.visits += r.movedVisits;
    tally.by_stage[lead.status] = (tally.by_stage[lead.status] || 0) + 1;
  };

  const movable = leads.filter((l) => l.company_id === target.company_id);
  tally.left = leads.length - movable.length;
  for (let i = 0; i < movable.length; i += LEAD_CHUNK) {
    const chunk = movable.slice(i, i + LEAD_CHUNK);
    const done: Array<[Lead, Moved]> = [];
    try {
      await p.$transaction(async (tx) => {
        done.length = 0;
        for (const lead of chunk) done.push([lead, await moveOne(tx, lead)]);
      });
      done.forEach(([l, r]) => count(l, r));
    } catch (e) {
      logger.error('[handover] chunk failed, moving one by one:', e);
      for (const lead of chunk) {
        try {
          count(lead, await p.$transaction((tx) => moveOne(tx, lead)));
        } catch (err) {
          tally.failed++;
          logger.error(`[handover] lead ${lead.id} not moved:`, err);
        }
      }
    }
  }
  return tally;
}
