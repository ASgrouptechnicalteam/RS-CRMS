import { Prisma, PrismaClient } from '@prisma/client';
import { auditContext } from '../utils/requestContext';
import { dbGuard } from './dbGuard';
import { forgetAuthRows } from './authRowCache';
import { currentPushLink, pushForNotificationRows } from '../utils/pushDispatch';
import { createMdLookup, isImportantForMd } from '../utils/mdNotificationPolicy';
import { Roles } from '../shared';
import { recordQueryTime } from './queryTiming';

/**
 * Singleton Prisma Client instance for the API.
 * Prevents multiple instances from exhausting the connection pool,
 * especially during sequential test runs.
 */
const dbUrl = process.env.DATABASE_URL || '';

// Pool size is a trade-off on this host. MySQL closes idle connections after
// 20 s (wait_timeout), so after any quiet spell the pool is empty and the next
// page load (~8 API calls at once) opens up to `limit` new connections from
// one address. Measured over 3 page loads: pool 10 = 31 new connections,
// pool 5 = 16, pool 3 = 10. Hostinger's firewall blocked the server on 29 Oct
// and 3 Nov, and a pool of 10 + 3 can look like a connection flood, so stay
// small: a page's queries wait ~120 ms longer, which beats an outage.
// DB_CONNECTION_LIMIT overrides the size. A connection_limit in the URL does
// not: a forgotten value in a Render setting must not undo this.
// connect_timeout: give up on an unreachable database quickly. pool_timeout:
// with fewer connections a query may queue a little longer.
const withPool = (url: string, size: number) => {
  if (!url) return url;
  const parsed = new URL(url);
  parsed.searchParams.set('connection_limit', String(size));
  if (!parsed.searchParams.has('connect_timeout')) parsed.searchParams.set('connect_timeout', '10');
  if (!parsed.searchParams.has('pool_timeout')) parsed.searchParams.set('pool_timeout', '30');
  return parsed.toString();
};

const poolSize = Number(process.env.DB_CONNECTION_LIMIT) || 5;
const mainDbUrl = withPool(dbUrl, poolSize);

// Prisma's default interactive-transaction limit is 5 s. With the database in
// another region every query is a full network round trip, so ordinary
// multi-step writes (reassigning a lead, moving it to Negotiation, completing
// a visit) ran past it and failed with "Transaction already closed" -- seen
// at 5.1 s, 5.2 s and 7.1 s on staging. 88 transactions rely on the default,
// so raise it once here instead of per call. maxWait is how long a
// transaction may queue for a free connection.
export const TRANSACTION_OPTIONS = { maxWait: 10000, timeout: 30000 };

export const prisma = new PrismaClient({
  ...(mainDbUrl ? { datasources: { db: { url: mainDbUrl } } } : {}),
  transactionOptions: TRANSACTION_OPTIONS,
});

// Before anything else: refuse queries while the database is unreachable, and
// retry a read that lost its connection (lib/dbGuard.ts).
prisma.$use((params, next) =>
  dbGuard.run({ action: params.action, runInTransaction: params.runInTransaction }, () =>
    next(params),
  ),
);

// How long each call takes, for the Technical Manager's system health
// (lib/queryTiming.ts; memory only, never written to the database).
prisma.$use(async (params, next) => {
  const started = performance.now();
  try {
    return await next(params);
  } finally {
    recordQueryTime(params.model, params.action, performance.now() - started);
  }
});

// Money columns are exact decimals in the database (DECIMAL(14,2) on Booking,
// Payment, Installment and ExpenseRefund; item 6 #8, 2026-11-15). Prisma hands
// a DECIMAL back as a Decimal object, which prints as a string in JSON and does
// not add or compare like a number. Every result is turned back into plain
// numbers here, so the API's answers and the existing sums stay as they were;
// the database does the exact storing and rounding to paise. In code, read a
// money value with num() / round2() from utils/money.ts, never .toNumber().
// Petty cash and the budget work on Decimal objects themselves and are left alone.
const KEEP_DECIMAL = new Set(['PettyCashEntry', 'MonthlyBudget', 'MonthlyBudgetLine']);
const plainNumbers = (v: any): any => {
  if (v === null || typeof v !== 'object') return v;
  if (Prisma.Decimal.isDecimal(v)) return (v as Prisma.Decimal).toNumber();
  if (v instanceof Date || Buffer.isBuffer(v)) return v;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const x = v[i];
      if (x !== null && typeof x === 'object') v[i] = plainNumbers(x);
    }
    return v;
  }
  for (const k of Object.keys(v)) {
    const x = v[k];
    if (x !== null && typeof x === 'object') v[k] = plainNumbers(x);
  }
  return v;
};
prisma.$use(async (params, next) => {
  const result = await next(params);
  return params.model && KEEP_DECIMAL.has(params.model) ? result : plainNumbers(result);
});

// A changed employee must take effect at once (lib/authRowCache.ts).
const READ_ACTIONS = /^(find|count|aggregate|groupBy)/;
prisma.$use(async (params, next) => {
  const result = await next(params);
  if (params.model === 'Employee' && !READ_ACTIONS.test(params.action)) forgetAuthRows();
  return result;
});

// Every audit record written during a request gets the company, IP address
// and device of that request (utils/requestContext.ts), so the ~60 places
// that write AuditEvent don't each have to pass them. Values a caller sets
// itself are kept.
prisma.$use(async (params, next) => {
  if (
    params.model === 'AuditEvent' &&
    (params.action === 'create' || params.action === 'createMany')
  ) {
    const ctx = auditContext();
    if (ctx) {
      const fill = (row: any) => ({
        ...row,
        company_id: row.company_id ?? ctx.company_id,
        ip: row.ip ?? ctx.ip,
        user_agent: row.user_agent ?? ctx.user_agent,
      });
      const data = params.args?.data;
      if (data) params.args.data = Array.isArray(data) ? data.map(fill) : fill(data);
    }
  }
  return next(params);
});

// The Managing Director only gets important notifications (utils/mdNotificationPolicy.ts).
// Applied here so it holds for every code path that creates a Notification row, and
// before the push below, so a dropped row is not pushed to the phone either.
const isManagingDirector = createMdLookup((employeeId) =>
  prisma.employeeRole.count({ where: { employee_id: employeeId, role: { name: Roles.MD } } }),
);
prisma.$use(async (params, next) => {
  if (
    params.model !== 'Notification' ||
    (params.action !== 'create' && params.action !== 'createMany')
  ) {
    return next(params);
  }
  const link = currentPushLink();
  const keep = async (row: any) =>
    !row ||
    row.employee_id == null ||
    isImportantForMd({ type: row.type, title: row.title, link }) ||
    !(await isManagingDirector(Number(row.employee_id)));

  const data = params.args?.data;
  if (params.action === 'create') {
    if (data && !(await keep(data))) {
      // Not created. Callers only use the row for its fields, never read it back.
      return { ...data, id: 0 };
    }
  } else if (Array.isArray(data)) {
    const kept: any[] = [];
    for (const row of data) if (await keep(row)) kept.push(row);
    if (kept.length === 0) return { count: 0 };
    params.args.data = kept;
  }
  return next(params);
});

// Every Notification row, whichever code path created it, also goes to the
// person's phone (utils/pushDispatch.ts). Fire and forget: the write is never
// slowed, failed or rolled back by the push. Inside a transaction the push may
// leave before the commit, so it waits a little.
prisma.$use(async (params, next) => {
  // Read before the write: the async context may not survive the query engine.
  const link = currentPushLink();
  const result = await next(params);
  if (
    params.model === 'Notification' &&
    (params.action === 'create' || params.action === 'createMany')
  ) {
    try {
      const opts = { link, delayMs: params.runInTransaction ? 400 : 0 };
      if (params.action === 'create') {
        pushForNotificationRows([result], opts);
      } else {
        const data = params.args?.data;
        pushForNotificationRows(Array.isArray(data) ? data : data ? [data] : [], opts);
      }
    } catch {
      /* never break the write */
    }
  }
  return result;
});

const publicDbUrl = withPool(dbUrl, 2);

export const publicPrisma = new PrismaClient({
  datasources: {
    db: {
      url: publicDbUrl,
    },
  },
  transactionOptions: TRANSACTION_OPTIONS,
});
publicPrisma.$use((params, next) =>
  dbGuard.run({ action: params.action, runInTransaction: params.runInTransaction }, () =>
    next(params),
  ),
);

export default prisma;
