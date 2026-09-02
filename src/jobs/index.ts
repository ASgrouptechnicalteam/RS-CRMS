import cron from 'node-cron';
import { logger } from '../utils/logger';

// Job functions will be registered here.
export type JobFn = () => Promise<void>;

interface JobConfig {
  name: string;
  schedule: string;
  handler: JobFn;
  envDisableKey: string;
}

export class JobManager {
  private jobs: JobConfig[] = [];

  register(config: JobConfig) {
    this.jobs.push(config);
  }

  startAll() {
    this.jobs.forEach(job => {
      if (process.env[job.envDisableKey] === 'true') {
        logger.info(`[Jobs] Skipping ${job.name} (Disabled via ${job.envDisableKey})`);
        return;
      }

      logger.info(`[Jobs] Scheduling ${job.name} at ${job.schedule}`);
      cron.schedule(job.schedule, async () => {
        try {
          logger.info(`[Jobs] Starting ${job.name}...`);
          await job.handler();
          logger.info(`[Jobs] Completed ${job.name} successfully.`);
        } catch (error) {
          logger.error({ err: error }, `[Jobs] FAILURE in ${job.name}: Alerting system!`);
        }
      });
    });
  }

  // Used for manual execution & testing idempotency
  async trigger(name: string) {
    const job = this.jobs.find(j => j.name === name);
    if (!job) throw new Error(`Job ${name} not found`);
    logger.info(`[Jobs] Manually triggering ${job.name}...`);
    try {
      await job.handler();
      logger.info(`[Jobs] Manual execution of ${job.name} completed successfully.`);
    } catch (error) {
      logger.error({ err: error }, `[Jobs] FAILURE in manual execution of ${job.name}: Alerting system!`);
      throw error;
    }
  }
}

export const jobManager = new JobManager();
