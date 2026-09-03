"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.jobManager = exports.JobManager = void 0;
const node_cron_1 = __importDefault(require("node-cron"));
const logger_1 = require("../utils/logger");
class JobManager {
    constructor() {
        this.jobs = [];
    }
    register(config) {
        this.jobs.push(config);
    }
    startAll() {
        this.jobs.forEach(job => {
            if (process.env[job.envDisableKey] === 'true') {
                logger_1.logger.info(`[Jobs] Skipping ${job.name} (Disabled via ${job.envDisableKey})`);
                return;
            }
            logger_1.logger.info(`[Jobs] Scheduling ${job.name} at ${job.schedule}`);
            node_cron_1.default.schedule(job.schedule, async () => {
                try {
                    logger_1.logger.info(`[Jobs] Starting ${job.name}...`);
                    await job.handler();
                    logger_1.logger.info(`[Jobs] Completed ${job.name} successfully.`);
                }
                catch (error) {
                    logger_1.logger.error({ err: error }, `[Jobs] FAILURE in ${job.name}: Alerting system!`);
                }
            });
        });
    }
    // Used for manual execution & testing idempotency
    async trigger(name) {
        const job = this.jobs.find(j => j.name === name);
        if (!job)
            throw new Error(`Job ${name} not found`);
        logger_1.logger.info(`[Jobs] Manually triggering ${job.name}...`);
        try {
            await job.handler();
            logger_1.logger.info(`[Jobs] Manual execution of ${job.name} completed successfully.`);
        }
        catch (error) {
            logger_1.logger.error({ err: error }, `[Jobs] FAILURE in manual execution of ${job.name}: Alerting system!`);
            throw error;
        }
    }
}
exports.JobManager = JobManager;
exports.jobManager = new JobManager();
