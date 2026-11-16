import { prisma } from '../lib/prisma';
import { getISTComponents, getISTMidnightInstant } from '../utils/time';
import { num, round2 } from '../utils/money';

/**
 * Collections view and portal sync exceptions (item 6 #3 and #6, 2026-11-15).
 * Read-only. "Overdue" is worked out on read, the same way as everywhere else:
 * not received, not cancelled, due before today (IST).
 */
const OPEN = ['PENDING', 'PARTIALLY_RECEIVED', 'OVERDUE'];
const DAY_MS = 864e5;

const BOOKING_SELECT = {
  id: true,
  booking_code: true,
  company_id: true,
  customer: { select: { first_name: true, last_name: true, phone: true } },
  assigned_employee: { select: { full_name: true } },
  property: { select: { title: true, project: { select: { id: true, name: true } } } },
  project_unit: { select: { unit_code: true, project: { select: { id: true, name: true } } } },
} as const;

type BookingRow = {
  id: number;
  booking_code: string;
  company_id: number;
  customer: { first_name: string; last_name: string | null; phone: string };
  assigned_employee: { full_name: string } | null;
  property: { title: string; project: { id: number; name: string } | null } | null;
  project_unit: { unit_code: string | null; project: { id: number; name: string } } | null;
};

const projectOf = (b: BookingRow) =>
  b.project_unit?.project ?? b.property?.project ?? { id: 0, name: 'No project' };
const customerName = (b: BookingRow) =>
  [b.customer.first_name, b.customer.last_name].filter(Boolean).join(' ');

const monthRange = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return {
    start: new Date(`${month}-01T00:00:00+05:30`),
    end: new Date(`${next}-01T00:00:00+05:30`),
  };
};

export async function collectionsView(companyIds: number[], month: string, now: Date = new Date()) {
  const today = getISTMidnightInstant(getISTComponents(now).dateString);
  const weekEnd = new Date(today.getTime() + 7 * DAY_MS); // today and the next 6 days
  const { start, end } = monthRange(month);

  const [installments, payments] = await Promise.all([
    prisma.installment.findMany({
      where: {
        status: { in: OPEN },
        due_date: { lt: weekEnd },
        booking: { company_id: { in: companyIds }, status: { not: 'CANCELLED' } },
      },
      select: {
        id: true,
        installment_number: true,
        expected_amount: true,
        received_amount: true,
        due_date: true,
        booking: { select: BOOKING_SELECT },
      },
      orderBy: { due_date: 'desc' }, // latest first
    }),
    prisma.payment.findMany({
      where: {
        company_id: { in: companyIds },
        status: 'SUCCESS',
        payment_date: { gte: start, lt: end },
      },
      select: { amount: true, booking: { select: BOOKING_SELECT } },
    }),
  ]);

  type Project = {
    project_id: number;
    project: string;
    overdue_count: number;
    overdue_amount: number;
    due_week_count: number;
    due_week_amount: number;
    received_count: number;
    received_amount: number;
  };
  const projects = new Map<number, Project>();
  const slot = (b: BookingRow) => {
    const pr = projectOf(b);
    let s = projects.get(pr.id);
    if (!s) {
      s = {
        project_id: pr.id,
        project: pr.name,
        overdue_count: 0,
        overdue_amount: 0,
        due_week_count: 0,
        due_week_amount: 0,
        received_count: 0,
        received_amount: 0,
      };
      projects.set(pr.id, s);
    }
    return s;
  };

  const line = (i: (typeof installments)[number]) => {
    const b = i.booking as BookingRow;
    return {
      installment_id: i.id,
      installment_number: i.installment_number,
      booking_id: b.id,
      booking_code: b.booking_code,
      customer: customerName(b),
      phone: b.customer.phone,
      owner: b.assigned_employee?.full_name ?? null,
      project: projectOf(b).name,
      due_date: i.due_date,
      amount_due: round2(Math.max(num(i.expected_amount) - num(i.received_amount), 0)),
      // Whole calendar days (IST), so "due yesterday" is 1 at any hour.
      days_late: Math.max(
        Math.round(
          (today.getTime() -
            getISTMidnightInstant(getISTComponents(i.due_date).dateString).getTime()) /
            DAY_MS,
        ),
        0,
      ),
    };
  };

  const overdue: ReturnType<typeof line>[] = [];
  const dueWeek: ReturnType<typeof line>[] = [];
  for (const i of installments) {
    const l = line(i);
    if (l.amount_due <= 0) continue;
    const s = slot(i.booking as BookingRow);
    if (i.due_date < today) {
      overdue.push(l);
      s.overdue_count++;
      s.overdue_amount = round2(s.overdue_amount + l.amount_due);
    } else {
      dueWeek.push(l);
      s.due_week_count++;
      s.due_week_amount = round2(s.due_week_amount + l.amount_due);
    }
  }
  let received = 0;
  for (const pay of payments) {
    const s = slot(pay.booking as BookingRow);
    s.received_count++;
    s.received_amount = round2(s.received_amount + num(pay.amount));
    received = round2(received + num(pay.amount));
  }
  const sum = (rows: { amount_due: number }[]) =>
    round2(rows.reduce((t, r) => t + r.amount_due, 0));

  return {
    month,
    totals: {
      overdue_count: overdue.length,
      overdue_amount: sum(overdue),
      due_week_count: dueWeek.length,
      due_week_amount: sum(dueWeek),
      received_count: payments.length,
      received_amount: received,
    },
    by_project: [...projects.values()].sort(
      (a, b) => b.overdue_amount - a.overdue_amount || b.received_amount - a.received_amount,
    ),
    overdue: overdue.slice(0, 200),
    due_this_week: dueWeek.slice(0, 200),
  };
}

/**
 * Payments that need a person: waiting to reach the customer portal for more
 * than a day, and refunds due on cancelled bookings.
 */
export async function syncExceptions(companyIds: number[], now: Date = new Date()) {
  const dayAgo = new Date(now.getTime() - DAY_MS);
  const select = {
    id: true,
    payment_code: true,
    amount: true,
    status: true,
    payment_method: true,
    payment_date: true,
    updated_at: true,
    booking: { select: BOOKING_SELECT },
  } as const;
  const [stuck, refundDue] = await Promise.all([
    prisma.payment.findMany({
      where: {
        company_id: { in: companyIds },
        sync_status: 'PENDING_SYNC',
        updated_at: { lt: dayAgo },
      },
      select,
      orderBy: { updated_at: 'desc' },
      take: 200,
    }),
    prisma.payment.findMany({
      where: { company_id: { in: companyIds }, status: 'REFUND_DUE' },
      select,
      orderBy: { updated_at: 'desc' },
      take: 200,
    }),
  ]);
  const shape = (r: (typeof stuck)[number]) => {
    const b = r.booking as BookingRow;
    return {
      payment_id: r.id,
      payment_code: r.payment_code,
      amount: round2(r.amount),
      status: r.status,
      payment_method: r.payment_method,
      payment_date: r.payment_date,
      booking_id: b.id,
      booking_code: b.booking_code,
      customer: customerName(b),
      project: projectOf(b).name,
      waiting_since: r.updated_at,
      days_waiting: Math.floor((now.getTime() - r.updated_at.getTime()) / DAY_MS),
    };
  };
  const total = (rows: { amount: unknown }[]) =>
    round2(rows.reduce((t, r) => t + num(r.amount), 0));
  return {
    sync_pending: { count: stuck.length, amount: total(stuck), rows: stuck.map(shape) },
    refund_due: { count: refundDue.length, amount: total(refundDue), rows: refundDue.map(shape) },
  };
}
