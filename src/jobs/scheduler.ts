import { jobManager } from './index';
import * as tasks from './tasks';

// 1. Lead follow-up reminders (Daily at 8:00 AM)
jobManager.register({
  name: 'Lead Follow-Up Reminders',
  schedule: '0 8 * * *',
  handler: tasks.leadFollowUpJob,
  envDisableKey: 'DISABLE_JOB_LEAD_FOLLOW_UP'
});

// 2. Stale lead flagging (Daily at 1:00 AM)
jobManager.register({
  name: 'Stale Lead Flagging',
  schedule: '0 1 * * *',
  handler: tasks.staleLeadFlaggingJob,
  envDisableKey: 'DISABLE_JOB_STALE_LEADS'
});

// 3. Daily attendance rollup (Daily at 11:55 PM)
jobManager.register({
  name: 'Daily Attendance Rollup',
  schedule: '55 23 * * *',
  handler: tasks.dailyAttendanceRollupJob,
  envDisableKey: 'DISABLE_JOB_ATTENDANCE_ROLLUP'
});

// 4. Expired session cleanup (Daily at 3:00 AM)
jobManager.register({
  name: 'Expired Session Cleanup',
  schedule: '0 3 * * *',
  handler: tasks.expiredSessionCleanupJob,
  envDisableKey: 'DISABLE_JOB_SESSION_CLEANUP'
});

// 5. Commission calculation batch (Monthly on the 1st at 2:00 AM)
jobManager.register({
  name: 'Commission Calculation Batch',
  schedule: '0 2 1 * *',
  handler: tasks.commissionCalculationBatchJob,
  envDisableKey: 'DISABLE_JOB_COMMISSION'
});

// 6. Backup verification (Daily at 6:00 AM)
jobManager.register({
  name: 'Backup Verification',
  schedule: '0 6 * * *',
  handler: tasks.backupVerificationJob,
  envDisableKey: 'DISABLE_JOB_BACKUP_VERIFY'
});

// 7. Report generation (Weekly on Monday at 7:00 AM)
jobManager.register({
  name: 'Report Generation',
  schedule: '0 7 * * 1',
  handler: tasks.reportGenerationJob,
  envDisableKey: 'DISABLE_JOB_REPORT_GEN'
});

// 8. Intentional failing job (For testing failure alert)
jobManager.register({
  name: 'Failing Test Job',
  schedule: '0 0 * * *', // midnight, but triggered manually
  handler: tasks.failingTestJob,
  envDisableKey: 'DISABLE_JOB_FAILING_TEST'
});

export const initJobs = () => {
  jobManager.startAll();
};
