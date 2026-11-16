import os from 'os';
import { monitorEventLoopDelay } from 'perf_hooks';
import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';
import { notifyEmployee } from '../utils/notifyEmployee';
import { Roles } from '../shared';
import { getISTComponents } from '../utils/time';
import { queryTimes, SLOW_MS } from '../lib/queryTiming';

/**
 * System health for the Technical Manager (item 9, 2026-11-15).
 *
 * The database plan is capped (3,072 MB on Hostinger) and the master-data
 * import alone is about 1.8 GB, so database size is the number that matters
 * most. Every metric is read on its own: one that the host does not allow
 * shows as "not available" instead of failing the page.
 */

const p = prisma;
const MB = 1024 * 1024;

/** Plan limits. DB_SIZE_CAP_MB / INSTANCE_RAM_MB override them. */
export const DB_CAP_MB = Number(process.env.DB_SIZE_CAP_MB) || 3072;
const RAM_MB = Number(process.env.INSTANCE_RAM_MB) || 512;
/** Amber from 70% of a limit, red from 90%. */
export const AMBER = 0.7;
export const RED = 0.9;
export type Level = 'ok' | 'amber' | 'red';
export const levelOf = (used: number, cap: number): Level =>
  cap > 0 && used >= cap * RED ? 'red' : cap > 0 && used >= cap * AMBER ? 'amber' : 'ok';

// ---------------------------------------------------------------- live probes

// Event-loop delay since the server started (ms). Cheap; always on.
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    logger.warn({ err }, '[SystemHealth] metric not available');
    return null;
  }
}

type TableRow = { name: string; bytes: bigint | number | null; rows: bigint | number | null };

async function tableSizes() {
  const rows = await p.$queryRaw<TableRow[]>`
    SELECT TABLE_NAME AS name, (DATA_LENGTH + INDEX_LENGTH) AS bytes, TABLE_ROWS AS \`rows\`
    FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()
    ORDER BY (DATA_LENGTH + INDEX_LENGTH) DESC`;
  return rows.map((r) => ({
    name: r.name,
    bytes: Number(r.bytes || 0),
    rows: Number(r.rows || 0),
  }));
}

async function ourConnections() {
  const [mine] = await p.$queryRaw<{ n: bigint | number }[]>`
    SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST
    WHERE USER = SUBSTRING_INDEX(CURRENT_USER(), '@', 1)`;
  const [cap] = await p.$queryRaw<{ Value: string }[]>`SHOW VARIABLES LIKE 'max_user_connections'`;
  const limit = Number(cap?.Value || 0);
  return { ours: Number(mine?.n || 0), limit: limit || null };
}

/** Database size N days ago, from the snapshots (null if none that old). */
async function sizeDaysAgo(days: number) {
  const before = new Date(Date.now() - days * 864e5);
  const row = await p.systemMetricSnapshot.findFirst({
    where: { metric: 'db_bytes', company_id: null, snapshot_date: { lte: before } },
    orderBy: { snapshot_date: 'desc' },
  });
  return row ? { date: row.snapshot_date, bytes: Number(row.value) } : null;
}

/** GET /admin/system-health: everything on one screen, each part on its own. */
export async function systemHealth() {
  const [tables, conns, month] = await Promise.all([
    safe(tableSizes),
    safe(ourConnections),
    safe(() => sizeDaysAgo(30)),
  ]);
  const dbBytes = tables ? tables.reduce((n, t) => n + t.bytes, 0) : null;
  const dbMb = dbBytes === null ? null : Math.round((dbBytes / MB) * 10) / 10;
  const q = queryTimes();
  const mem = process.memoryUsage();
  const rssMb = Math.round(mem.rss / MB);
  const load = os.loadavg()[0];
  const cores = os.cpus().length || 1;
  const growth30 =
    dbBytes !== null && month && month.bytes > 0
      ? Math.round(((dbBytes - month.bytes) / month.bytes) * 1000) / 10
      : null;

  return {
    generated_at: new Date().toISOString(),
    database: {
      size_mb: dbMb,
      cap_mb: DB_CAP_MB,
      percent: dbMb === null ? null : Math.round((dbMb / DB_CAP_MB) * 1000) / 10,
      level: dbMb === null ? null : levelOf(dbMb, DB_CAP_MB),
      growth_30d_percent: growth30,
      growth_level: growth30 === null ? null : growth30 > 10 ? 'amber' : 'ok',
      tables: (tables || []).slice(0, 15).map((t) => ({
        name: t.name,
        size_mb: Math.round((t.bytes / MB) * 10) / 10,
        est_rows: t.rows,
      })),
    },
    connections: conns
      ? {
          ours: conns.ours,
          limit: conns.limit,
          level: conns.limit ? levelOf(conns.ours, conns.limit) : null,
          pool: { main: Number(process.env.DB_CONNECTION_LIMIT) || 5, public: 2 },
        }
      : null,
    queries: {
      timed_since_start: q.timed,
      p95_ms: q.p95,
      p95_level: (q.p95 ?? 0) > SLOW_MS ? 'amber' : 'ok',
      slowest: q.slowest,
    },
    server: {
      uptime_hours: Math.round((process.uptime() / 3600) * 10) / 10,
      rss_mb: rssMb,
      ram_mb: RAM_MB,
      // Amber from 75% of the instance's memory, red from 90%.
      rss_level: rssMb >= RAM_MB * RED ? 'red' : rssMb >= RAM_MB * 0.75 ? 'amber' : 'ok',
      heap_used_mb: Math.round(mem.heapUsed / MB),
      load_1m: Math.round(load * 100) / 100,
      cores,
      load_level: load / cores > 0.8 ? 'amber' : 'ok',
      event_loop_p95_ms: Math.round(loopDelay.percentile(95) / 1e6),
      event_loop_level: loopDelay.percentile(95) / 1e6 > 200 ? 'amber' : 'ok',
    },
  };
}

// ---------------------------------------------------------------- daily job

/** Per-company row counts kept for growth (exact COUNT(*), once a night). */
const COMPANY_COUNTS: { metric: string; sql: (companyId: number) => Promise<number> }[] = [
  { metric: 'rows:Lead', sql: (c) => p.lead.count({ where: { company_id: c } }) },
  {
    metric: 'rows:LeadActivity',
    sql: (c) => p.leadActivity.count({ where: { lead: { company_id: c } } }),
  },
  { metric: 'rows:AuditEvent', sql: (c) => p.auditEvent.count({ where: { company_id: c } }) },
  {
    metric: 'rows:SiteVisitBooking',
    sql: (c) => p.siteVisitBooking.count({ where: { lead: { company_id: c } } }),
  },
  { metric: 'rows:MasterLead', sql: (c) => p.masterLead.count({ where: { company_id: c } }) },
];

const KEEP_DAYS = 400;

/**
 * 03:30 IST: write today's snapshot (database size, each table's size and
 * estimated rows, per-company counts), drop rows older than 400 days, and warn
 * the Admin / Technical Manager / MD when the database passes 70% of its cap.
 * Safe to re-run the same day: that day's rows are replaced.
 */
export async function metricSnapshotJob(now: Date = new Date(), capMb: number = DB_CAP_MB) {
  const date = new Date(`${getISTComponents(now).dateString}T00:00:00Z`);
  const tables = await tableSizes();
  const dbBytes = tables.reduce((n, t) => n + t.bytes, 0);
  const rows: { company_id: number | null; metric: string; value: bigint }[] = [
    { company_id: null, metric: 'db_bytes', value: BigInt(dbBytes) },
    ...tables.flatMap((t) => [
      { company_id: null, metric: `table_bytes:${t.name}`, value: BigInt(t.bytes) },
      { company_id: null, metric: `table_est_rows:${t.name}`, value: BigInt(t.rows) },
    ]),
  ];
  const companies = await p.company.findMany({ select: { id: true } });
  for (const c of companies) {
    for (const m of COMPANY_COUNTS) {
      const n = await safe(() => m.sql(c.id));
      if (n !== null) rows.push({ company_id: c.id, metric: m.metric, value: BigInt(n) });
    }
  }
  await p.$transaction([
    p.systemMetricSnapshot.deleteMany({ where: { snapshot_date: date } }),
    p.systemMetricSnapshot.createMany({
      data: rows.map((r) => ({ ...r, snapshot_date: date })),
    }),
    p.systemMetricSnapshot.deleteMany({
      where: { snapshot_date: { lt: new Date(date.getTime() - KEEP_DAYS * 864e5) } },
    }),
  ]);

  const dbMb = dbBytes / MB;
  const level = levelOf(dbMb, capMb);
  logger.info(
    `[SystemHealth] Snapshot ${date.toISOString().slice(0, 10)}: database ${Math.round(dbMb)} MB of ${capMb} MB (${level}), ${rows.length} numbers.`,
  );
  if (level !== 'ok') {
    const people = await p.employee.findMany({
      where: {
        status: 'ACTIVE',
        roles: {
          some: { role: { name: { in: [Roles.ADMIN, Roles.TECHNICAL_MANAGER, Roles.MD] } } },
        },
      },
      select: { id: true },
    });
    if (people.length) {
      const pct = Math.round((dbMb / capMb) * 100);
      await notifyEmployee(
        people.map((x) => x.id),
        {
          type: 'SYSTEM',
          title: level === 'red' ? 'Database almost full' : 'Database filling up',
          message: `The CRM database is ${Math.round(dbMb)} MB of ${capMb} MB (${pct}%). Plan more space or archive old master data before it fills.`,
          link: '/dashboard',
        },
      );
    }
  }
  return { rows: rows.length, db_mb: Math.round(dbMb), level };
}
