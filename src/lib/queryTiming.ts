/**
 * How long database calls take, kept in memory since the server started
 * (item 9, 2026-11-15). Filled by a Prisma middleware in lib/prisma.ts and
 * read by services/systemHealth.ts. No imports, so lib/prisma.ts can use it.
 */
export const SLOW_MS = 500;
const SLOW_KEEP = 50;
const RECENT_KEEP = 2000;

const slow: { model: string; action: string; ms: number; at: string }[] = [];
const recent: number[] = [];
let timed = 0;

export function recordQueryTime(model: string | undefined, action: string, ms: number) {
  timed++;
  recent.push(ms);
  if (recent.length > RECENT_KEEP) recent.shift();
  if (ms < SLOW_MS) return;
  slow.push({ model: model || 'raw', action, ms: Math.round(ms), at: new Date().toISOString() });
  slow.sort((a, b) => b.ms - a.ms);
  if (slow.length > SLOW_KEEP) slow.length = SLOW_KEEP;
}

export function queryTimes() {
  let p95: number | null = null;
  if (recent.length) {
    const s = [...recent].sort((a, b) => a - b);
    p95 = Math.round(s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]);
  }
  return { timed, p95, slowest: [...slow] };
}
