// Every API call checks the signed-in person's status in the database, and each
// check is a round trip to a remote server: a page load (~8 calls) paid for it 8
// times. Remember the answer briefly. Any change to an employee on this server
// clears it at once (lib/prisma.ts), so a lock-out, password reset or sign-out is
// immediate here; a change made on another server takes effect within 15 s.
const KEEP_MS = 15_000;
const rows = new Map<number, { at: number; row: unknown }>();

export const rememberedAuthRow = <T>(employeeId: number): T | undefined => {
  const hit = rows.get(employeeId);
  if (!hit) return undefined;
  if (Date.now() - hit.at >= KEEP_MS) {
    rows.delete(employeeId);
    return undefined;
  }
  return hit.row as T;
};

export const rememberAuthRow = (employeeId: number, row: unknown) => {
  rows.set(employeeId, { at: Date.now(), row });
};

export const forgetAuthRows = () => rows.clear();
