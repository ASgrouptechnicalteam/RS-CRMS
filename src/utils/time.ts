import { AttendanceStatus, AttendanceStatusType } from '../shared';

export interface ISTTimeComponents {
  hours: number;
  minutes: number;
  timeString: string;
  dateString: string;
}

/**
 * Converts a JS Date to IST (Asia/Kolkata) time components.
 */
export const getISTComponents = (date: Date = new Date()): ISTTimeComponents => {
  const istFormatter = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  const parts = istFormatter.formatToParts(date);
  let hours = 0;
  let minutes = 0;
  let year = '';
  let month = '';
  let day = '';

  for (const part of parts) {
    if (part.type === 'hour') hours = parseInt(part.value, 10);
    if (part.type === 'minute') minutes = parseInt(part.value, 10);
    if (part.type === 'year') year = part.value;
    if (part.type === 'month') month = part.value;
    if (part.type === 'day') day = part.value;
  }

  const timeString = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
  const dateString = `${year}-${month}-${day}`;

  return { hours, minutes, timeString, dateString };
};

/**
 * Calculates Attendance Status according to RRH Business Rules (IST):
 * 1. FULL_TIME: <= 10:30 AM IST -> PRESENT; 10:31-11:30 -> LATE or APPROVED_LATE;
 *    > 11:30 -> HALF_DAY or APPROVED_HALF_DAY.
 * 2. PART_TIME / CONTRACT / INTERN: no late/early/half-day penalties — status is
 *    always PRESENT and attendance is tracked via working_duration_minutes (check-in/out).
 */
export const calculateAttendanceStatus = (
  checkInDate: Date = new Date(),
  hasApprovedProposal: boolean = false,
  employmentType: string = 'FULL_TIME'
): AttendanceStatusType => {
  // PART_TIME / CONTRACT / INTERN — no penalty marks, duration tracked via check-in/out
  if (employmentType === 'PART_TIME' || employmentType === 'CONTRACT' || employmentType === 'INTERN') {
    return AttendanceStatus.PRESENT;
  }

  // FULL_TIME — existing cutoff-based marks
  const { hours, minutes } = getISTComponents(checkInDate);
  const totalMinutes = hours * 60 + minutes;

  const cutoff1030 = 10 * 60 + 30; // 630 minutes
  const cutoff1130 = 11 * 60 + 30; // 690 minutes

  if (totalMinutes <= cutoff1030) {
    return AttendanceStatus.PRESENT;
  }

  if (totalMinutes <= cutoff1130) {
    return hasApprovedProposal ? AttendanceStatus.APPROVED_LATE : AttendanceStatus.LATE;
  }

  // After 11:30 AM IST -> Half day rule
  return hasApprovedProposal ? AttendanceStatus.APPROVED_HALF_DAY : AttendanceStatus.HALF_DAY;
};
