import { logger } from '../utils/logger';
import { jobManager } from './index';
import * as tasks from './tasks';
import { sweepOverdueTasks } from '../services/taskOverdue';

// 1. Lead follow-up reminders (Daily at 8:00 AM)
jobManager.register({
  name: 'Lead Follow-Up Reminders',
  schedule: '0 8 * * *',
  handler: tasks.leadFollowUpJob,
  envDisableKey: 'DISABLE_JOB_LEAD_FOLLOW_UP',
});

// 2. Stale lead flagging (Daily at 1:00 AM)
jobManager.register({
  name: 'Stale Lead Flagging',
  schedule: '0 1 * * *',
  handler: tasks.staleLeadFlaggingJob,
  envDisableKey: 'DISABLE_JOB_STALE_LEADS',
});

// 3. Daily attendance rollup (11:58 PM, IST): force-checkout anyone still
// checked in and escalate a summary notification to HR (falling back to MD
// if the company has no HR_MANAGER employee onboarded).
jobManager.register({
  name: 'Daily Attendance Rollup',
  schedule: '58 23 * * *',
  handler: tasks.dailyAttendanceRollupJob,
  envDisableKey: 'DISABLE_JOB_ATTENDANCE_ROLLUP',
});

// 4. Expired session cleanup (Daily at 3:00 AM)
jobManager.register({
  name: 'Expired Session Cleanup',
  schedule: '0 3 * * *',
  handler: tasks.expiredSessionCleanupJob,
  envDisableKey: 'DISABLE_JOB_SESSION_CLEANUP',
});

// 5. Commission calculation batch (Monthly on the 1st at 2:00 AM)
jobManager.register({
  name: 'Commission Calculation Batch',
  schedule: '0 2 1 * *',
  handler: tasks.commissionCalculationBatchJob,
  envDisableKey: 'DISABLE_JOB_COMMISSION',
});

// 6. Backup verification (Daily at 6:00 AM)
jobManager.register({
  name: 'Backup Verification',
  schedule: '0 6 * * *',
  handler: tasks.backupVerificationJob,
  envDisableKey: 'DISABLE_JOB_BACKUP_VERIFY',
});

// 7. Weekly / monthly reports (every 30 minutes; acts only from 07:00 IST on
// a Monday or the 1st until the end of the third day, once per period).
jobManager.register({
  name: 'Report Generation',
  schedule: '*/30 * * * *',
  handler: () => tasks.reportGenerationJob(),
  envDisableKey: 'DISABLE_JOB_REPORT_GEN',
});

// 8. Site Visit Escalation (Every 15 minutes)
jobManager.register({
  name: 'Site Visit Escalation',
  schedule: '*/15 * * * *',
  handler: tasks.siteVisitEscalationJob,
  envDisableKey: 'DISABLE_JOB_SITE_VISIT_ESCALATION',
});

// 9. Stale Reschedule Notification (Hourly)
jobManager.register({
  name: 'Stale Reschedule Sweep',
  schedule: '0 * * * *',
  handler: tasks.staleRescheduleSweepJob,
  envDisableKey: 'DISABLE_JOB_STALE_RESCHEDULE',
});

// 10. Lead Recovery Job (Mechanism 1 Nightly Sweep) (Daily at 2:00 AM)
jobManager.register({
  name: 'Lead Recovery Sweep',
  schedule: '0 2 * * *',
  handler: tasks.leadRecoveryJob,
  envDisableKey: 'DISABLE_JOB_LEAD_RECOVERY',
});

// 11. Inventory lock/hold expiry sweep (Every 15 minutes) — reclaims expired
// booking locks proactively (matching Site Visit Escalation's cadence, since
// a stale lock produces the same "search and booking disagree" class of bug)
// and clears expired manual HOLDs back to AVAILABLE.
jobManager.register({
  name: 'Inventory Lock & Hold Expiry Sweep',
  schedule: '*/15 * * * *',
  handler: tasks.inventoryLockAndHoldExpirySweepJob,
  envDisableKey: 'DISABLE_JOB_INVENTORY_EXPIRY',
});

import { siteVisitReconfirmReminderJob } from './visitReminders';

// 12. T-1 Site Visit Reconfirmation Reminder (Daily at 9:00 AM)
jobManager.register({
  name: 'T-1 Site Visit Reminder',
  schedule: '0 9 * * *',
  handler: siteVisitReconfirmReminderJob,
  envDisableKey: 'DISABLE_JOB_VISIT_REMINDERS',
});

// 13. Overdue task sweep (Every 15 minutes) -- flips open tasks past their
// target time to OVERDUE and alerts each company's MD with one summary. This
// used to happen inside the task-list requests themselves.
jobManager.register({
  name: 'Overdue Task Sweep',
  schedule: '*/15 * * * *',
  handler: async () => {
    await sweepOverdueTasks();
  },
  envDisableKey: 'DISABLE_JOB_TASK_OVERDUE',
});

import { reminderSweepJob } from './reminders';

// 14. Reminders (every 10 minutes): check-in, tasks and visits today, HR and
// Finance queues, end-of-day report, checkout. Each goes once a day per
// person, inside its time window (see jobs/reminders.ts).
jobManager.register({
  name: 'Reminders',
  schedule: '*/10 * * * *',
  handler: async () => {
    await reminderSweepJob();
  },
  envDisableKey: 'DISABLE_JOB_REMINDERS',
});

import { recheckAbsences } from '../services/absenceRecheck';

// 15. Absence re-check (daily 00:30): cancels uninformed-absence penalties for
// days that were excused later -- a holiday entered after the day, a leave or
// comp-off approved late (see services/absenceRecheck.ts).
jobManager.register({
  name: 'Absence Re-check',
  schedule: '30 0 * * *',
  handler: async () => {
    await recheckAbsences({ days: 45 });
  },
  envDisableKey: 'DISABLE_JOB_ABSENCE_RECHECK',
});

import { offboardDueLeavers } from '../services/employeeOffboard.service';

// 16. Leavers (hourly at :05): anyone whose last working day is over is locked
// out and their open work goes to the colleague HR picked. Hourly, not
// nightly, because the host sleeps; login is refused after the last day
// regardless (middleware/auth.ts), so this only does the status + hand-over.
jobManager.register({
  name: 'Offboard Leavers',
  schedule: '5 * * * *',
  handler: async () => {
    await offboardDueLeavers();
  },
  envDisableKey: 'DISABLE_JOB_OFFBOARD',
});

// Database growth history and the "database filling up" warning (item 9,
// 2026-11-15). 03:30 IST; relies on keepAwake keeping the free host up.
import { metricSnapshotJob } from '../services/systemHealth';
jobManager.register({
  name: 'Metric Snapshot',
  schedule: '30 3 * * *',
  handler: async () => {
    await metricSnapshotJob();
  },
  envDisableKey: 'DISABLE_JOB_METRIC_SNAPSHOT',
});

// Overdue / due-in-7-days installments to the accountant and booking owners
// (item 6 #1, 2026-11-15). 09:00 IST.
import { installmentDigestJob } from '../services/installmentDigest';
jobManager.register({
  name: 'Installment Digest',
  schedule: '0 9 * * *',
  handler: async () => {
    await installmentDigestJob();
  },
  envDisableKey: 'DISABLE_JOB_INSTALLMENT_DIGEST',
});

// Monthly budget reminders: the accountant on the 25th, the MD on the 1st
// (item 4, 2026-11-15). Checks daily at 10:00 IST.
import { budgetReminderJob } from '../services/budgetReminder';
jobManager.register({
  name: 'Budget Reminder',
  schedule: '0 10 * * *',
  handler: async () => {
    await budgetReminderJob();
  },
  envDisableKey: 'DISABLE_JOB_BUDGET_REMINDER',
});

// Work updates (2026-11-16): a reminder to the digital team after 90 minutes
// with nothing running (09:30-18:30 IST); anything left running pauses at 19:00.
import { workUpdateNudgeJob } from '../services/workUpdates';
jobManager.register({
  name: 'Work Update Reminder',
  schedule: '*/15 * * * *',
  handler: async () => {
    await workUpdateNudgeJob();
  },
  envDisableKey: 'DISABLE_JOB_WORK_UPDATE_REMINDER',
});

// Assets (2026-11-16): SIM recharges due in 3 days, warranties ending in 30 days.
import { assetReminderJob } from '../services/assets';
import { digitalAssetReminderJob } from '../services/digitalAssets';
import { recordRecentTargetResults } from '../services/targetPeriods';
import { meetingReminderJob } from '../services/meetings';
jobManager.register({
  name: 'Asset Reminder',
  schedule: '30 9 * * *',
  handler: async () => {
    await assetReminderJob();
  },
  envDisableKey: 'DISABLE_JOB_ASSET_REMINDER',
});

export const initJobs = () => {
  jobManager.startAll();

  // The host sleeps, so scheduled runs get missed: catch up on every start.
  // One after another, not all at once -- a wake-up used to open every
  // connection in the pool together. A failure does not stop the next one.
  const catchUps: [string, string, () => Promise<unknown>][] = [
    ['DISABLE_JOB_ABSENCE_RECHECK', 'Absence re-check', () => recheckAbsences({ days: 45 })],
    // The 3:00 session clean-up.
    ['DISABLE_JOB_SESSION_CLEANUP', 'Session clean-up', () => tasks.expiredSessionCleanupJob()],
    ['DISABLE_JOB_OFFBOARD', 'Offboard leavers', () => offboardDueLeavers()],
    // The 23:58 rollup, if last night's run never happened.
    ['DISABLE_JOB_ATTENDANCE_ROLLUP', 'Attendance rollup', () => tasks.runMissedDailyRollup()],
    // "Your report is ready", if the Monday / 1st window is open and it has not gone out.
    ['DISABLE_JOB_REPORT_GEN', 'Report generation', () => tasks.reportGenerationJob()],
  ];
  void (async () => {
    for (const [disableKey, name, run] of catchUps) {
      if (process.env[disableKey] === 'true') continue;
      try {
        await run();
      } catch (err) {
        logger.error({ err }, `[Jobs] ${name} on start failed`);
      }
    }
  })();
};

// Renewal and expiry reminders for digital assets (plans, subscriptions, domains), 09:40 IST.
jobManager.register({
  name: 'Digital Asset Renewals',
  schedule: '40 9 * * *',
  handler: async () => {
    await digitalAssetReminderJob();
  },
  envDisableKey: 'DISABLE_JOB_DIGITAL_ASSETS',
});

// Target results for the day, week or month that just ended move the performance score (00:20 IST).
jobManager.register({
  name: 'Target Results',
  schedule: '20 0 * * *',
  handler: async () => {
    await recordRecentTargetResults();
  },
  envDisableKey: 'DISABLE_JOB_TARGET_RESULTS',
});

// A reminder to everyone invited, about 30 minutes before a meeting starts (every 5 minutes).
jobManager.register({
  name: 'Meeting Reminders',
  schedule: '*/5 * * * *',
  handler: async () => {
    await meetingReminderJob();
  },
  envDisableKey: 'DISABLE_JOB_MEETING_REMINDERS',
});
