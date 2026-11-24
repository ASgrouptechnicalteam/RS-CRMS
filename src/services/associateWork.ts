import { prisma } from '../lib/prisma';

/**
 * What a Channel Partner Manager did with associates in a period, counted from the Associates page records
 * (follow-ups, enrolments, leads they added). One place, used by the daily report, the weekly and monthly
 * report, the targets and the CPM dashboard, so they can never disagree.
 *
 * Kept free of other services on purpose (targets, reports and dashboards all import it).
 */
const p = prisma as any;

/** Answers that mean the associate was actually spoken to (the rest: no answer, busy, wrong number, call back). */
export const SPOKE_OUTCOMES = [
  'REACHED',
  'AGREED',
  'THINKING',
  'DECLINED',
  'HAS_LEAD',
  'WANTS_VISIT',
  'NO_UPDATE',
];

/** Stages before someone has joined (keep in sync with associate.service.ts). */
const PROSPECT_STAGES = ['INVITED', 'CONTACTED', 'AGREED', 'DOCUMENTS'];

export interface AssociateWork {
  /** Calls to associates (not customer calls). */
  calls: number;
  /** Of those, the first call ever to someone who had not joined yet at the time. */
  new_calls: number;
  /** The rest: calling again someone already called (thinking, call back...), and calls to joined associates. */
  follow_up_calls: number;
  /** Calls where the associate was actually spoken to. */
  spoke: number;
  /** "Agreed to work with us" answers. */
  agreed: number;
  office_visits: number;
  /** Visits the associate made themselves (logged as a visit). */
  site_visits: number;
  /** Site visits this CPM booked for customers who came through an associate. */
  visits_booked: number;
  /** Associates of this CPM who were enrolled in the period. */
  enrolled: number;
  /** Leads this CPM added that come from an associate. */
  leads: number;
}

export async function associateWork(
  employeeId: number,
  range: { start: Date; end: Date },
): Promise<AssociateWork> {
  const when = { gte: range.start, lt: range.end };
  const [followUps, enrolled, leads, visitsBooked] = await Promise.all([
    p.associateFollowUp.findMany({
      where: { employee_id: employeeId, created_at: when },
      select: {
        id: true,
        associate_id: true,
        channel: true,
        outcome: true,
        created_at: true,
        associate: { select: { enrolled_at: true, pipeline: true } },
      },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    }),
    p.associate.count({ where: { owner_cpm_id: employeeId, enrolled_at: when } }),
    p.lead.count({
      where: { created_by_id: employeeId, associate_id: { not: null }, created_at: when },
    }),
    p.siteVisitBooking.count({
      where: {
        telecaller_id: employeeId,
        status: { not: 'CANCELLED' },
        created_at: when,
        lead: { associate_id: { not: null } },
      },
    }),
  ]);
  const calls = followUps.filter((f: any) => f.channel === 'CALL');
  // Who was called before this period, by anyone: their next call is a follow-up, not a new call.
  const ids = [...new Set(calls.map((f: any) => f.associate_id as number))];
  const calledBefore = new Set<number>();
  for (let i = 0; i < ids.length; i += 1000) {
    const rows = await p.associateFollowUp.findMany({
      where: {
        associate_id: { in: ids.slice(i, i + 1000) },
        channel: 'CALL',
        created_at: { lt: range.start },
      },
      select: { associate_id: true },
      distinct: ['associate_id'],
    });
    for (const r of rows) calledBefore.add(r.associate_id);
  }
  // New call = the first call ever to someone who had not joined yet (a prospect now, or joined after this call).
  let newCalls = 0;
  for (const f of calls) {
    const first = !calledBefore.has(f.associate_id);
    calledBefore.add(f.associate_id);
    const prospect =
      PROSPECT_STAGES.includes(f.associate?.pipeline) ||
      (!!f.associate?.enrolled_at && f.associate.enrolled_at > f.created_at);
    if (first && prospect) newCalls++;
  }
  return {
    calls: calls.length,
    new_calls: newCalls,
    follow_up_calls: calls.length - newCalls,
    spoke: calls.filter((f: any) => SPOKE_OUTCOMES.includes(f.outcome)).length,
    agreed: followUps.filter((f: any) => f.outcome === 'AGREED').length,
    office_visits: followUps.filter((f: any) => f.channel === 'OFFICE_VISIT').length,
    site_visits: followUps.filter((f: any) => f.channel === 'SITE_VISIT').length,
    enrolled,
    leads,
    visits_booked: visitsBooked,
  };
}
