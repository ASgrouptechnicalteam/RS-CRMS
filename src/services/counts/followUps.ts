import { prisma } from '../../lib/prisma';
import { getISTComponents } from '../../utils/time';
import { CALL_BACK_TITLE_PREFIX } from '../lead/callBacks';

const p = prisma;

/** A lead a telecaller is still working: every open stage, as on the telecaller report. */
export const CALLABLE_STATUSES = [
  'NEW',
  'ASSIGNED',
  'CONTACTED',
  'QUALIFIED',
  'DEMO_SCHEDULED',
  'DEMO_COMPLETED',
  'SITE_VISIT_SCHEDULED',
  'SITE_VISIT_COMPLETED',
  'NEGOTIATION',
  'BOOKING_INITIATED',
];

export const openCallBackWhere = {
  title: { startsWith: CALL_BACK_TITLE_PREFIX },
  status: { notIn: ['COMPLETED', 'CANCELLED', 'NOT_COMPLETED', 'BLOCKED'] },
};

export interface FollowUpsDue {
  callbacks_due: number;
  callbacks_overdue: number;
  retries_due: number;
  total: number;
}
const none = (): FollowUpsDue => ({
  callbacks_due: 0,
  callbacks_overdue: 0,
  retries_due: 0,
  total: 0,
});

/**
 * The one meaning of "follow-ups due", per person, for every screen:
 *  - call-backs on or before the end of today (IST) on leads they still own;
 *  - retries: leads with no call-back whose last call, before today, was not answered.
 * A call-back left behind on a lead that moved stays on the old owner's record as
 * overdue, but it is no longer theirs to make, so it is not counted as due.
 */
export async function followUpsDue(
  employeeIds: number[],
  companyId: number,
  now: Date = new Date(),
): Promise<Map<number, FollowUpsDue>> {
  const result = new Map(employeeIds.map((id) => [id, none()]));
  if (employeeIds.length === 0) return result;
  const today = getISTComponents(now).dateString;
  const dayStart = new Date(`${today}T00:00:00+05:30`);
  const endOfToday = new Date(`${today}T23:59:59.999+05:30`);

  const callBacks = await p.task.findMany({
    where: {
      ...openCallBackWhere,
      assignee_id: { in: employeeIds },
      target_date: { lte: endOfToday },
      lead: {
        company_id: companyId,
        status: { in: CALLABLE_STATUSES },
        referred_to_cp_id: null,
      },
    },
    select: { assignee_id: true, target_date: true, lead: { select: { assigned_to_id: true } } },
  });
  for (const t of callBacks) {
    if (t.lead?.assigned_to_id !== t.assignee_id) continue;
    const row = result.get(t.assignee_id)!;
    row.callbacks_due++;
    if (t.target_date && t.target_date < now) row.callbacks_overdue++;
  }

  const idMarks = employeeIds.map(() => '?').join(',');
  const statusMarks = CALLABLE_STATUSES.map(() => '?').join(',');
  const retries = await p.$queryRawUnsafe<{ owner: number; n: bigint }[]>(
    `SELECT l.assigned_to_id AS owner, COUNT(*) AS n
     FROM Lead l
     JOIN LeadActivity a ON a.id = (
       SELECT MAX(x.id) FROM LeadActivity x
       WHERE x.lead_id = l.id AND x.activity_type = 'CALL_LOGGED'
     )
     WHERE l.company_id = ?
       AND l.assigned_to_id IN (${idMarks})
       AND l.status IN (${statusMarks})
       AND l.referred_to_cp_id IS NULL
       AND a.created_at < ?
       AND (a.call_outcome IN ('NO_ANSWER', 'BUSY_OR_SWITCHED_OFF')
            OR (a.call_outcome IS NULL
                AND (a.notes LIKE '[No answer]%' OR a.notes LIKE '[Busy / switched off]%')))
       AND NOT EXISTS (
         SELECT 1 FROM Task t
         WHERE t.lead_id = l.id AND t.assignee_id = l.assigned_to_id
           AND t.title LIKE ?
           AND t.status NOT IN ('COMPLETED', 'CANCELLED', 'NOT_COMPLETED', 'BLOCKED')
       )
     GROUP BY l.assigned_to_id`,
    companyId,
    ...employeeIds,
    ...CALLABLE_STATUSES,
    dayStart,
    `${CALL_BACK_TITLE_PREFIX}%`,
  );
  for (const r of retries) result.get(Number(r.owner))!.retries_due = Number(r.n);

  for (const row of result.values()) row.total = row.callbacks_due + row.retries_due;
  return result;
}
