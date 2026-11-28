/**
 * A work-from-home day (owner, 2026-11-28).
 * - A request sent on the day itself marks the check-in at the time it was sent, once it is approved.
 * - Check-out shows from 5:30 PM; the button opens from 6:00 PM, after the daily report.
 */
import { prisma } from '../lib/prisma';
import { calculateAttendanceStatus, getISTComponents, getISTMidnightInstant } from '../utils/time';
import { dayInfo } from './workCalendar';
import { getLogoutBlockers } from './dayPlan.service';

const p = prisma;
const DAY_MS = 24 * 60 * 60 * 1000;

export const CHECK_OUT_SHOWN_FROM = '17:30';
export const CHECK_OUT_OPEN_FROM = '18:00';

const dayRange = (dateString: string) => {
  const start = getISTMidnightInstant(dateString);
  return { gte: start, lt: new Date(start.getTime() + DAY_MS) };
};

/**
 * Called when a work-from-home request is approved. Returns the check-in time it marked, or null when there was
 * nothing to mark: the request was for another day, they are already checked in, or it is their day off.
 */
export async function markCheckInFromRequest(proposal: {
  employee_id: number;
  target_date: Date;
  created_at: Date;
}): Promise<Date | null> {
  const day = getISTComponents(proposal.target_date).dateString;
  if (getISTComponents(proposal.created_at).dateString !== day) return null;

  const employee = await p.employee.findUnique({ where: { id: proposal.employee_id } });
  if (!employee || employee.status !== 'ACTIVE') return null;
  const info = await dayInfo(
    {
      id: employee.id,
      company_id: employee.company_id,
      weekly_off_day: employee.weekly_off_day,
    },
    day,
  );
  if (info.offDay) return null;

  const already = await p.attendanceLog.findFirst({
    where: { employee_id: employee.id, check_in_at: dayRange(day) },
    select: { id: true },
  });
  if (already) return null;

  const lateApproved = await p.attendanceProposal.findFirst({
    where: {
      employee_id: employee.id,
      type: 'LATE_CHECKIN',
      status: 'APPROVED',
      target_date: dayRange(day),
    },
    select: { id: true },
  });
  // The same time rules as pressing "Check in" at that moment.
  await p.attendanceLog.create({
    data: {
      employee_id: employee.id,
      check_in_at: proposal.created_at,
      status: calculateAttendanceStatus(
        proposal.created_at,
        !!lateApproved,
        employee.employment_type || 'FULL_TIME',
      ),
      source: 'REMOTE',
      notes: 'Work from home (checked in at the time the request was sent)',
    },
  });
  return proposal.created_at;
}

/** What stands between this person and checking out today. The server enforces the same rules on check-out. */
export async function checkOutState(employee: {
  id: number;
  attendance_required: boolean;
  report_required: boolean;
}) {
  const { dateString, timeString } = getISTComponents(new Date());
  const range = dayRange(dateString);
  const [early, report, blockers] = await Promise.all([
    // An emergency early logout (approved, or still waiting) opens check-out before 6 PM.
    p.attendanceProposal.findFirst({
      where: {
        employee_id: employee.id,
        type: 'EARLY_CHECKOUT',
        status: { in: ['APPROVED', 'PENDING'] },
        target_date: range,
      },
      select: { id: true },
    }),
    employee.report_required
      ? p.dailyReport.findFirst({
          where: { employee_id: employee.id, submitted_at: range },
          select: { id: true },
        })
      : null,
    getLogoutBlockers(employee),
  ]);
  const timeOk = timeString >= CHECK_OUT_OPEN_FROM || !!early;
  const reportNeeded = employee.report_required && !report;
  return {
    show: timeString >= CHECK_OUT_SHOWN_FROM || !!early,
    can_check_out: timeOk && !reportNeeded && !blockers.blocked,
    time_ok: timeOk,
    report_needed: reportNeeded,
    other: blockers.blocked ? blockers.message : null,
  };
}
