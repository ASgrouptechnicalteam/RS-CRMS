import { logger } from '../utils/logger';

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

// Intentionally failing job to test alerting
export const failingTestJob = async () => {
  logger.info('Executing Failing Test Job...');
  throw new Error('This is an intentional failure to test the job alerting mechanism.');
};
