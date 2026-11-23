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
  /** Of those, to people who had not joined yet at the time. */
  new_calls: number;
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
        channel: true,
        outcome: true,
        created_at: true,
        associate: { select: { enrolled_at: true, pipeline: true } },
      },
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
  return {
    calls: calls.length,
    // A call to someone who had not joined yet: they are a prospect now, or they joined after this call.
    new_calls: calls.filter(
      (f: any) =>
        PROSPECT_STAGES.includes(f.associate?.pipeline) ||
        (!!f.associate?.enrolled_at && f.associate.enrolled_at > f.created_at),
    ).length,
    spoke: calls.filter((f: any) => SPOKE_OUTCOMES.includes(f.outcome)).length,
    agreed: followUps.filter((f: any) => f.outcome === 'AGREED').length,
    office_visits: followUps.filter((f: any) => f.channel === 'OFFICE_VISIT').length,
    site_visits: followUps.filter((f: any) => f.channel === 'SITE_VISIT').length,
    enrolled,
    leads,
    visits_booked: visitsBooked,
  };
}
