import { logger } from '../utils/logger';

// Hostinger's firewall has cut a server off from MySQL twice (29 Oct, 3 Nov)
// and did not let go for days. Each failed connection attempt can make that
// worse (MySQL blocks an address after max_connect_errors = 5), and the app
// used to retry on every request. So: after a few failures in a row, stop
// trying and answer 503 at once; try again with one request at a time, waiting
// longer each time. Recovery needs nobody: the first probe that works reopens
// the app.
const FAILURES_TO_OPEN = 3;
const FIRST_WAIT_MS = 30_000;
const MAX_WAIT_MS = 10 * 60_000;
const READ_RETRY_DELAY_MS = 300;

// Can't reach / timed out / connection closed.
const OUTAGE_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017']);
// Our own pool queue was full: the database is fine, so this must not trip the
// guard, but a read can safely try again.
const POOL_BUSY = 'P2024';
const READS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'queryRaw',
]);

export class DatabaseUnavailableError extends Error {
  status = 503;
  code = 'DB_UNAVAILABLE';
  constructor() {
    super('The system is reconnecting to the database. Please try again in a minute.');
    this.name = 'DatabaseUnavailableError';
  }
}

const errorCode = (err: any): string => err?.code || err?.errorCode || '';

/** The database could not be reached (not: it answered with an error). */
export const isOutageError = (err: any): boolean =>
  OUTAGE_CODES.has(errorCode(err)) || err?.name === 'PrismaClientInitializationError';

export class DbGuard {
  private failures = 0;
  private waitMs = FIRST_WAIT_MS;
  private openUntil = 0;
  private open = false;
  private probing = false;

  constructor(private now: () => number = Date.now) {}

  /** True while requests should be refused without touching the database. */
  isOpen() {
    return this.open && (this.now() < this.openUntil || this.probing);
  }

  /** Seconds until the next attempt, for the Retry-After header. */
  retryAfterSeconds() {
    return Math.max(1, Math.ceil((this.openUntil - this.now()) / 1000));
  }

  /** May this query go to the database? While open, only one probe at a time. */
  private allow() {
    if (!this.open) return true;
    if (this.isOpen()) return false;
    this.probing = true;
    return true;
  }

  private success() {
    if (this.open) logger.info('[db] Database reachable again; back to normal.');
    this.failures = 0;
    this.waitMs = FIRST_WAIT_MS;
    this.open = false;
    this.probing = false;
  }

  private failure() {
    this.failures++;
    const wasProbe = this.probing;
    this.probing = false;
    if (!this.open && this.failures < FAILURES_TO_OPEN) return;
    if (wasProbe) this.waitMs = Math.min(this.waitMs * 2, MAX_WAIT_MS);
    this.open = true;
    this.openUntil = this.now() + this.waitMs;
    logger.error(
      `[db] Database unreachable (${this.failures} failures in a row); next try in ${Math.round(this.waitMs / 1000)} s.`,
    );
  }

  /** Any answer from the database, even an error, proves it is reachable. */
  private settle(err: unknown) {
    if (isOutageError(err)) this.failure();
    else if (errorCode(err) !== POOL_BUSY) this.success();
    else this.probing = false;
  }

  /** Prisma middleware: refuse while open; a dropped read gets one quiet retry. */
  async run<T>(
    params: { action: string; runInTransaction?: boolean },
    next: () => Promise<T>,
  ): Promise<T> {
    if (!this.allow()) throw new DatabaseUnavailableError();
    try {
      const result = await next();
      this.success();
      return result;
    } catch (err) {
      const canRetry =
        (isOutageError(err) || errorCode(err) === POOL_BUSY) &&
        READS.has(params.action) &&
        !params.runInTransaction;
      if (!canRetry) {
        this.settle(err);
        throw err;
      }
      await new Promise((r) => setTimeout(r, READ_RETRY_DELAY_MS));
      try {
        const result = await next();
        this.success();
        return result;
      } catch (again) {
        this.settle(again);
        throw again;
      }
    }
  }
}

export const dbGuard = new DbGuard();
