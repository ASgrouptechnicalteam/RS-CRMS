import { getISTComponents } from '../../utils/time';

/**
 * IST periods, the one place that knows where a day, week or month starts.
 * Production runs on UTC: every boundary is built from an explicit +05:30
 * offset and never read back with a local-time accessor (no setHours/getDay).
 * A week runs Monday 00:00 to the next Monday 00:00 IST; a month from the 1st.
 * `end` is always exclusive.
 */
export type PeriodType = 'DAY' | 'WEEK' | 'MONTH' | 'QUARTER' | 'ALL';

export interface Period {
  type: PeriodType;
  start: Date;
  end: Date;
  /** IST calendar date of the first day, "YYYY-MM-DD". */
  startDate: string;
  label: string;
}

const DAY_MS = 24 * 3600 * 1000;
const pad = (n: number) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** IST midnight of a "YYYY-MM-DD" date. */
export const istMidnight = (date: string) => new Date(`${date}T00:00:00+05:30`);
/** IST calendar date of an instant. */
export const istDate = (d: Date) => getISTComponents(d).dateString;

const ymd = (date: string) => date.split('-').map(Number) as [number, number, number];
const addDays = (date: string, n: number) => {
  const [y, m, d] = ymd(date);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
};
const monthStart = (y: number, m: number) => {
  const yy = y + Math.floor((m - 1) / 12);
  const mm = ((((m - 1) % 12) + 12) % 12) + 1;
  return `${yy}-${pad(mm)}-01`;
};
const nice = (date: string) => {
  const [y, m, d] = ymd(date);
  return `${d} ${MONTHS[m - 1]} ${y}`;
};

function build(type: PeriodType, startDate: string): Period {
  const [y, m] = ymd(startDate);
  let endDate: string;
  let label: string;
  switch (type) {
    case 'DAY':
      endDate = addDays(startDate, 1);
      label = nice(startDate);
      break;
    case 'WEEK':
      endDate = addDays(startDate, 7);
      label = `Week of ${nice(startDate)}`;
      break;
    case 'MONTH':
      endDate = monthStart(y, m + 1);
      label = `${MONTHS[m - 1]} ${y}`;
      break;
    case 'QUARTER':
      endDate = monthStart(y, m + 3);
      label = `${MONTHS[m - 1]}–${MONTHS[(m + 1) % 12]} ${y}`;
      break;
    default:
      return {
        type: 'ALL',
        start: istMidnight('2000-01-01'),
        end: new Date(Date.now() + DAY_MS),
        startDate: '2000-01-01',
        label: 'All time',
      };
  }
  return { type, start: istMidnight(startDate), end: istMidnight(endDate), startDate, label };
}

/** The period of this type containing `at` (IST). */
export function periodContaining(type: PeriodType, at: Date = new Date()): Period {
  const today = istDate(at);
  const [y, m, d] = ymd(today);
  switch (type) {
    case 'DAY':
      return build('DAY', today);
    case 'WEEK': {
      const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
      return build('WEEK', addDays(today, -((dow + 6) % 7)));
    }
    case 'MONTH':
      return build('MONTH', monthStart(y, m));
    case 'QUARTER':
      return build('QUARTER', monthStart(y, m - ((m - 1) % 3)));
    default:
      return build('ALL', '2000-01-01');
  }
}

/** The period of this type that contains the IST date `date` (any day inside it). */
export const periodOf = (type: PeriodType, date: string) =>
  periodContaining(type, new Date(istMidnight(date).getTime() + 3600 * 1000));

export const previousPeriod = (p: Period) =>
  periodContaining(p.type, new Date(p.start.getTime() - 3600 * 1000));
export const nextPeriod = (p: Period) =>
  periodContaining(p.type, new Date(p.end.getTime() + 3600 * 1000));

/** The previous period cut at the same point as `p` is now, for a like-for-like comparison. */
export function previousComparable(p: Period, now: Date = new Date()) {
  const prev = previousPeriod(p);
  if (now >= p.end) return { start: prev.start, end: prev.end, label: prev.label };
  const elapsed = Math.max(0, now.getTime() - p.start.getTime());
  return {
    start: prev.start,
    end: new Date(Math.min(prev.end.getTime(), prev.start.getTime() + elapsed)),
    label: prev.label,
  };
}

export const isClosed = (p: Period, now: Date = new Date()) => p.end.getTime() <= now.getTime();

/** IST dates "YYYY-MM-DD" of every day in [start, end). */
export function daysIn(start: Date, end: Date): string[] {
  const out: string[] = [];
  for (let d = istDate(start); istMidnight(d) < end; d = addDays(d, 1)) out.push(d);
  return out;
}

/**
 * A caller's date range for an inclusive "startDate..endDate" pair of IST
 * calendar dates. Missing start = the 1st of this IST month; missing end =
 * now. A date-only end covers that whole day (end of the day, inclusive).
 */
export function parseDateRange(startDate?: unknown, endDate?: unknown, now: Date = new Date()) {
  const dateOnly = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const start = dateOnly(startDate)
    ? istMidnight(startDate as string)
    : typeof startDate === 'string' && startDate
      ? new Date(startDate)
      : periodContaining('MONTH', now).start;
  const end = dateOnly(endDate)
    ? new Date(istMidnight(addDays(endDate as string, 1)).getTime() - 1)
    : typeof endDate === 'string' && endDate
      ? new Date(endDate)
      : now;
  return { start, end };
}

/**
 * Prisma filter for audit events that are ABOUT a day in [start, end), not
 * created then. The night jobs write the day they judged into new_value
 * ({"date":"YYYY-MM-DD"}; an auto check-out stores the IST midnight that
 * ended the day, "<day>T18:30:00.000Z"), and run late when the host sleeps,
 * so created_at can fall in the next month. Rows with no new_value fall back
 * to created_at.
 */
export function aboutDaysIn(start: Date, end: Date) {
  const days = daysIn(start, end);
  return {
    OR: [
      ...days.map((d) => ({ new_value: { contains: `"date":"${d}"` } })),
      ...days.map((d) => ({ new_value: { contains: `"check_out_at":"${d}T18:30` } })),
      { new_value: null, created_at: { gte: start, lt: end } },
    ],
  };
}

/** The actions written by the night jobs about a day (see aboutDaysIn). */
export const DAY_STAMPED_ACTIONS = [
  'UNINFORMED_ABSENT',
  'ATTENDANCE_AUTO_CHECKOUT_MIDNIGHT',
  'MISSING_DAILY_REPORT',
  'COMPLETED_ALL_WORK',
];
