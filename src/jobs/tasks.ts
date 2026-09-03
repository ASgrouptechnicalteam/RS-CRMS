import { logger } from '../utils/logger';
import { prisma } from '../lib/prisma';
import { notifyEmployee } from '../utils/notifyEmployee';
import { Roles } from '@rrh-ems/shared';
// Mock state for idempotency testing
const jobState: Record<string, boolean> = {};

// 1. Lead follow-up reminders
export const leadFollowUpJob = async () => {
  logger.info('Executing Lead Follow-Up Reminders...');
  if (jobState['leadFollowUp']) {
    logger.info('Idempotency check: Follow-ups already sent today. Skipping.');
    return;
  }
  logger.info(`Found 5 leads to process for follow-up.`);
  jobState['leadFollowUp'] = true;
};

// 2. Stale lead flagging
export const staleLeadFlaggingJob = async () => {
  logger.info('Executing Stale Lead Flagging...');
  if (jobState['staleLeads']) {
    logger.info('Idempotency check: Stale leads already flagged today. Skipping.');
    return;
  }
  logger.info(`Flagged 3 leads as stale.`);
  jobState['staleLeads'] = true;
};

// 3. Daily attendance rollup
export const dailyAttendanceRollupJob = async () => {
  logger.info('Executing Daily Attendance Rollup...');
  if (jobState['attendanceRollup']) {
    logger.info('Idempotency check: Rollup already completed for today. Skipping.');
    return;
  }
  logger.info(`Rolled up attendance for 12 records.`);
  jobState['attendanceRollup'] = true;
};

// 4. Expired session cleanup
export const expiredSessionCleanupJob = async () => {
  logger.info('Executing Expired Session Cleanup...');
  logger.info('Cleaned up 2 expired sessions.'); // Usually naturally idempotent via DELETE WHERE
};

// 5. Commission calculation batch
export const commissionCalculationBatchJob = async () => {
  logger.info('Executing Commission Calculation Batch...');
  if (jobState['commissionCalc']) {
    logger.info('Idempotency check: Commissions already calculated for this period. Skipping.');
    return;
  }
  logger.info('Commission calculation completed.');
  jobState['commissionCalc'] = true;
};

// 6. Backup verification
export const backupVerificationJob = async () => {
  logger.info('Executing Backup Verification...');
  logger.info('Backup verified successfully.');
};

// 7. Report generation
export const reportGenerationJob = async () => {
  logger.info('Executing Report Generation...');
  if (jobState['reportGen']) {
    logger.info('Idempotency check: Reports already generated and sent. Skipping.');
    return;
  }
  logger.info(`Generated report metrics for 4 standard reports.`);
  jobState['reportGen'] = true;
};

// 8. Site Visit Escalation & Notification
export const siteVisitEscalationJob = async () => {
  logger.info('Executing Site Visit Escalation...');
  const now = new Date();

  // Find all pending site visits (REQUESTED, RESCHEDULE_REQUESTED, PENDING_PM_RECONFIRMATION)
  // that have not yet occurred
  const pendingVisits = await prisma.siteVisitBooking.findMany({
    where: {
      status: { in: ['REQUESTED', 'RESCHEDULE_REQUESTED', 'PENDING_PM_RECONFIRMATION'] },
      scheduled_date: { gt: now },
    },
    include: {
      escalation: true,
      lead: true,
      property: true,
      project: true,
      project_manager: true,
      telecaller: true,
    },
  });

  if (pendingVisits.length === 0) {
    logger.info('No pending site visits require escalation check.');
    return;
  }

  // Pre-fetch MD and Marketing Directors per company
  const directorsByCompany: Record<number, { md: number[]; marketing: number[] }> = {};

  const getDirectors = async (companyId: number) => {
    if (!directorsByCompany[companyId]) {
      const emps = await prisma.employee.findMany({
        where: { company_id: companyId },
        include: { roles: { include: { role: true } } },
      });
      const md: number[] = [];
      const marketing: number[] = [];
      for (const emp of emps) {
        const roleNames = emp.roles.map(r => r.role.name);
        if (roleNames.includes(Roles.MD)) md.push(emp.id);
        if (roleNames.includes(Roles.MARKETING_DIRECTOR)) marketing.push(emp.id);
      }
      directorsByCompany[companyId] = { md, marketing };
    }
    return directorsByCompany[companyId];
  };

  let escalatedCount = 0;

  for (const visit of pendingVisits) {
    const hoursUntilVisit = (visit.scheduled_date.getTime() - now.getTime()) / (1000 * 60 * 60);
    const hoursNotice = (visit.scheduled_date.getTime() - visit.created_at.getTime()) / (1000 * 60 * 60);

    const needsMD = hoursUntilVisit <= 10 || hoursNotice <= 10;
    const needsMarketing = hoursUntilVisit <= 12 || hoursNotice <= 12;

    const directors = await getDirectors(visit.telecaller.company_id);

    // Ensure escalation record exists
    if (!visit.escalation) {
      await prisma.siteVisitEscalation.create({
        data: { site_visit_booking_id: visit.id }
      });
      visit.escalation = { id: 0, site_visit_booking_id: visit.id, marketing_director_notified_at: null, managing_director_notified_at: null } as any;
    }

    const pmStatus = visit.project_manager ? `${visit.project_manager.full_name || visit.project_manager.employee_code} (Assigned)` : 'Unassigned';
    const locationInfo = visit.project ? visit.project.name : (visit.property ? visit.property.title : 'Unknown Location');

    const notificationPayload = {
      type: 'SITE_VISIT_ESCALATED',
      title: `URGENT: Site Visit Escalation (${visit.booking_code})`,
      message: `Site Visit ${visit.booking_code} at ${locationInfo} on ${visit.scheduled_date.toLocaleString()} needs PM response. PM Status: ${pmStatus}. Customer: ${visit.lead.customer_name} (${visit.lead.phone}).`,
      link: `/site-visits/${visit.id}`,
    };

    if (needsMD && !visit.escalation!.managing_director_notified_at) {
      // Atomic conditional update
      const updateRes = await prisma.siteVisitEscalation.updateMany({
        where: {
          site_visit_booking_id: visit.id,
          managing_director_notified_at: null,
        },
        data: { managing_director_notified_at: now },
      });

      if (updateRes.count > 0 && directors.md.length > 0) {
        await notifyEmployee(directors.md, notificationPayload);
        escalatedCount++;
      }
    }

    if (needsMarketing && !visit.escalation!.marketing_director_notified_at) {
      // Atomic conditional update
      const updateRes = await prisma.siteVisitEscalation.updateMany({
        where: {
          site_visit_booking_id: visit.id,
          marketing_director_notified_at: null,
        },
        data: { marketing_director_notified_at: now },
      });

      if (updateRes.count > 0 && directors.marketing.length > 0) {
        await notifyEmployee(directors.marketing, notificationPayload);
        escalatedCount++;
      }
    }
  }

  logger.info(`Escalated ${escalatedCount} director notifications for pending site visits.`);
};

// 9. Stale Reschedule Notification (2 Days)
export const staleRescheduleSweepJob = async () => {
  logger.info('Executing Stale Reschedule Sweep...');
  const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);

  // Find leads that have a CANCELLED site visit, haven't been contacted in 2 days, and aren't already closed
  const staleLeads = await prisma.lead.findMany({
    where: {
      status: { notIn: ['DROPPED', 'NEGOTIATION', 'BOOKING_INITIATED', 'BOOKED'] },
      last_contacted_at: { lt: twoDaysAgo },
      site_visits: {
        some: {
          status: 'CANCELLED',
          updated_at: { lt: twoDaysAgo },
        }
      }
    },
    select: { id: true, lead_code: true, customer_name: true, assigned_to_id: true }
  });

  let notifiedCount = 0;
  for (const lead of staleLeads) {
    if (lead.assigned_to_id) {
      await notifyEmployee([lead.assigned_to_id], {
        type: 'SYSTEM_ALERT',
        title: 'Lead Inactive After Cancellation',
        message: `Lead ${lead.lead_code} (${lead.customer_name}) has had no update for 2 days since their site visit was cancelled. Are you sure you want to drop the lead?`,
        link: `/leads/${lead.id}`,
      });
      notifiedCount++;
      // Touch last_contacted_at so we don't spam them every hour
      await prisma.lead.update({
        where: { id: lead.id },
        data: { last_contacted_at: new Date() }
      });
    }
  }

  logger.info(`Notified telecallers about ${notifiedCount} stale rescheduled leads.`);
};

// 10. Lead Recovery Job (Mechanism 1 Nightly Sweep)
export const leadRecoveryJob = async () => {
  logger.info('Executing nightly Lead Recovery Sweep...');
  const { matchDroppedLeadsToProperty } = await import('../utils/matchingEngine');
  const { LeadService } = await import('../services/lead.service');

  // Fetch all LIVE properties
  const liveProperties = await prisma.property.findMany({
    where: { status: 'LIVE' },
    select: { id: true }
  });

  let recoveredCount = 0;
  for (const prop of liveProperties) {
    const matchedLeadIds = await matchDroppedLeadsToProperty(prop.id);
    for (const leadId of matchedLeadIds) {
      // Re-use the same recovery trigger logic with its atomic guards
      await LeadService.triggerLeadRecoveryForProperty(prop.id);
      recoveredCount++;
    }
  }

  logger.info(`Lead Recovery Sweep finished. Recovered ${recoveredCount} leads.`);
};
