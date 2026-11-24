import os from 'os';
import { prisma } from './prisma';
import { logger } from '../utils/logger';

/**
 * Scheduled jobs run inside the web server. During a redeploy two copies can be alive at once, and each would
 * send the same reminders and reports. This lets only one copy run a given job at a time: the first to ask
 * gets the lock (a row in JobLock with an expiry, so a crashed copy cannot block the job for long).
 *
 * If the JobLock table does not exist yet (the SQL has not been run), jobs simply run as before and one
 * warning is logged, so the code can be released before or after the SQL without stopping anything.
 */
const p = prisma as any;
let warnedMissing = false;

const isMissingTable = (err: any) =>
  /JobLock/i.test(String(err?.message || '')) &&
  /(doesn't exist|does not exist|P2010|1146|no such table)/i.test(
    String(err?.message || '') + String(err?.code || ''),
  );

export async function withJobLock(
  name: string,
  run: () => Promise<unknown>,
  ttlMinutes = 30,
): Promise<'ran' | 'skipped'> {
  const holder = `${os.hostname()}-${process.pid}-${Date.now()}`.slice(0, 120);
  let locked = false;
  try {
    await p.$executeRaw`INSERT INTO JobLock (name, locked_until, holder)
      VALUES (${name}, DATE_ADD(NOW(3), INTERVAL ${ttlMinutes * 60} SECOND), ${holder})
      ON DUPLICATE KEY UPDATE
        holder = IF(locked_until < NOW(3), VALUES(holder), holder),
        locked_until = IF(locked_until < NOW(3), VALUES(locked_until), locked_until)`;
    const rows = (await p.$queryRaw`SELECT holder FROM JobLock WHERE name = ${name}`) as {
      holder: string;
    }[];
    if (rows[0]?.holder !== holder) {
      logger.info(`[Jobs] ${name} is already running on another copy of the server: skipped.`);
      return 'skipped';
    }
    locked = true;
  } catch (err) {
    if (isMissingTable(err)) {
      if (!warnedMissing) {
        warnedMissing = true;
        logger.warn(
          '[Jobs] JobLock table is missing: jobs run without the run-once lock. Run the JobLock SQL.',
        );
      }
    } else {
      // Could not reach the lock for another reason (database busy): run the job rather than lose it.
      logger.warn({ err }, `[Jobs] Could not take the lock for ${name}: running it anyway.`);
    }
  }
  try {
    await run();
    return 'ran';
  } finally {
    if (locked) {
      await p.$executeRaw`UPDATE JobLock SET locked_until = NOW(3) WHERE name = ${name} AND holder = ${holder}`.catch(
        () => undefined,
      );
    }
  }
}
