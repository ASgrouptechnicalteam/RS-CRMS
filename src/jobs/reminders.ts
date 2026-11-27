import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';
import { notifyEmployee } from '../utils/notifyEmployee';
import { getISTComponents } from '../utils/time';
import { dayInfoMany } from '../services/workCalendar';
import { Roles } from '../shared';
import { leadsPastEscalation, refreshPipelines } from '../services/associate.service';

import { ATTENTION_OVERDUE_DAYS } from '../services/projectAttention.service';

// Reminders for the working day. One sweep runs every 10 minutes; each
// reminder has a time window and goes to each person at most once a day (a
// notification of that type already sent today means "done"). The host
// sleeps when nobody uses the app, so fixed-time jobs were often missed;
// with a window, a reminder still goes out on the next sweep after wake-up,
// and is skipped once it would no longer help.

const p = prisma;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface Day {
  now: Date;
  dateString: string;
  start: Date;
  end: Date;
}

interface Reminder {
  type: string;
  /** IST "HH:MM" window, from inclusive, until exclusive. */
  from: string;
  until: string;
  run: (d: Day) => Promise<number>;
}

const hhmm = (now: Date) => {
  const { hours, minutes } = getISTComponents(now);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
};

/** Who already got a notification of this type today. */
async function sentToday(type: string, ids: number[], d: Day) {
  if (ids.length === 0) return new Set<number>();
  const rows = await p.notification.findMany({
    where: { type, employee_id: { in: ids }, created_at: { gte: d.start, lt: d.end } },
    select: { employee_id: true },
  });
  return new Set(rows.map((r) => r.employee_id));
}

async function sendOnce(
  type: string,
  d: Day,
  targets: { id: number; title: string; message: string; link: string }[],
) {
  const done = await sentToday(
    type,
    targets.map((t) => t.id),
    d,
  );
  let n = 0;
  for (const t of targets) {
    if (done.has(t.id)) continue;
    done.add(t.id);
    await notifyEmployee(t.id, { type, title: t.title, message: t.message, link: t.link });
    n++;
  }
  return n;
}

const notTopRole = {
  roles: { none: { role: { name: { in: [Roles.MD, Roles.ADMIN] } } } },
};

/** Logs of the day (check-in on that IST date), by employee. */
async function logsToday(d: Day, ids?: number[]) {
  const rows = await p.attendanceLog.findMany({
    where: {
      check_in_at: { gte: d.start, lt: d.end },
      ...(ids ? { employee_id: { in: ids } } : {}),
    },
    select: { employee_id: true, check_out_at: true },
  });
  const by = new Map<number, { open: boolean }>();
  for (const r of rows) {
    const prev = by.get(r.employee_id);
    by.set(r.employee_id, { open: (prev?.open ?? false) || r.check_out_at === null });
  }
  return by;
}

async function reportsToday(d: Day, ids: number[]) {
  if (ids.length === 0) return new Set<number>();
  const rows = await p.dailyReport.findMany({
    where: { employee_id: { in: ids }, submitted_at: { gte: d.start, lt: d.end } },
    select: { employee_id: true },
  });
  return new Set(rows.map((r) => r.employee_id));
}

// ---- 1. Not checked in yet (on time until 10:30) ----
export async function remindCheckIn(d: Day) {
  const staff = await p.employee.findMany({
    where: { status: 'ACTIVE', attendance_required: true, ...notTopRole },
    select: { id: true, company_id: true, weekly_off_day: true },
  });
  if (staff.length === 0) return 0;
  const ids = staff.map((s) => s.id);
  const [days, logs, leave] = await Promise.all([
    dayInfoMany(staff, d.dateString),
    logsToday(d, ids),
    p.attendanceProposal.findMany({
      where: {
        employee_id: { in: ids },
        type: 'LEAVE',
        status: 'APPROVED',
        target_date: { gte: d.start, lt: d.end },
      },
      select: { employee_id: true },
    }),
  ]);
  const onLeave = new Set(leave.map((l) => l.employee_id));
  const due = staff.filter((s) => !days.get(s.id)?.offDay && !logs.has(s.id) && !onLeave.has(s.id));
  return sendOnce(
    'REMINDER_CHECK_IN',
    d,
    due.map((s) => ({
      id: s.id,
      title: 'You have not checked in yet',
      message:
        'Scan the QR at the office (or check in from the app if you are working from home). Approved field work marks your attendance by itself. Check-ins after 10:30 are marked late.',
      link: '/my-attendance',
    })),
  );
}

// ---- 2. End-of-day report not sent (needed for the QR checkout) ----
export async function remindDailyReport(d: Day) {
  const logs = await logsToday(d);
  const staff = await p.employee.findMany({
    where: {
      id: { in: [...logs.keys()] },
      status: 'ACTIVE',
      report_required: true,
      ...notTopRole,
    },
    select: { id: true },
  });
  const sent = await reportsToday(
    d,
    staff.map((s) => s.id),
  );
  return sendOnce(
    'REMINDER_DAILY_REPORT',
    d,
    staff
      .filter((s) => !sent.has(s.id))
      .map((s) => ({
        id: s.id,
        title: 'Send your end-of-day report',
        message: 'Checkout by QR needs today’s report. It takes a minute: open My Day.',
        link: '/my-day',
      })),
  );
}

// ---- 3. Still checked in after 18:45 ----
export async function remindCheckOut(d: Day) {
  const logs = await logsToday(d);
  const openIds = [...logs.entries()].filter(([, v]) => v.open).map(([id]) => id);
  if (openIds.length === 0) return 0;
  const staff = await p.employee.findMany({
    where: { id: { in: openIds }, status: 'ACTIVE' },
    select: { id: true, report_required: true },
  });
  const sent = await reportsToday(
    d,
    staff.map((s) => s.id),
  );
  return sendOnce(
    'REMINDER_CHECK_OUT',
    d,
    staff.map((s) => {
      const needsReport = s.report_required && !sent.has(s.id);
      return {
        id: s.id,
        title: 'You are still checked in',
        message: needsReport
          ? 'Send your end-of-day report, then scan the QR to check out before you leave.'
          : 'Scan the QR to check out before you leave.',
        link: needsReport ? '/my-day' : '/my-attendance',
      };
    }),
  );
}

// ---- 4. Tasks due today ----
export async function remindTasksDue(d: Day) {
  const tasks = await p.task.findMany({
    where: {
      target_date: { gte: d.start, lt: d.end },
      status: { in: ['PENDING', 'IN_PROGRESS'] },
      assignee: { status: 'ACTIVE' },
    },
    select: { assignee_id: true, title: true },
    orderBy: { target_date: 'asc' },
  });
  const by = new Map<number, string[]>();
  for (const t of tasks) by.set(t.assignee_id, [...(by.get(t.assignee_id) || []), t.title]);
  return sendOnce(
    'REMINDER_TASKS_TODAY',
    d,
    [...by.entries()].map(([id, titles]) => ({
      id,
      title: `${titles.length} task${titles.length === 1 ? '' : 's'} due today`,
      message:
        titles
          .slice(0, 3)
          .map((t) => `“${t}”`)
          .join(', ') + (titles.length > 3 ? ` and ${titles.length - 3} more` : ''),
      link: '/tasks',
    })),
  );
}

// ---- 5. Site visits today (the telecaller, the agent and the project manager) ----
export async function remindVisitsToday(d: Day) {
  const visits = await p.siteVisitBooking.findMany({
    where: {
      scheduled_date: { gte: d.start, lt: d.end },
      status: { in: ['PENDING_ACCEPTANCE', 'ACCEPTED', 'CONFIRMED'] },
    },
    select: {
      scheduled_date: true,
      telecaller_id: true,
      assigned_agent_id: true,
      project_manager_id: true,
      lead: { select: { customer_name: true } },
    },
    orderBy: { scheduled_date: 'asc' },
  });
  const by = new Map<number, string[]>();
  for (const v of visits) {
    const { timeString } = getISTComponents(v.scheduled_date);
    const line = `${v.lead?.customer_name || 'Customer'} at ${timeString.slice(0, 5)}`;
    const people = new Set(
      [v.telecaller_id, v.assigned_agent_id, v.project_manager_id].filter((x): x is number => !!x),
    );
    for (const id of people) by.set(id, [...(by.get(id) || []), line]);
  }
  return sendOnce(
    'REMINDER_VISITS_TODAY',
    d,
    [...by.entries()].map(([id, lines]) => ({
      id,
      title: `${lines.length} site visit${lines.length === 1 ? '' : 's'} today`,
      message:
        lines.slice(0, 3).join(', ') + (lines.length > 3 ? ` and ${lines.length - 3} more` : ''),
      link: '/site-visits',
    })),
  );
}

/** Active people with a role, by company (the MD when a company has none). */
async function holdersByCompany(role: string, fallbackToMd: boolean) {
  const rows = await p.employee.findMany({
    where: { status: 'ACTIVE', roles: { some: { role: { name: role } } } },
    select: { id: true, company_id: true },
  });
  const by = new Map<number, number[]>();
  for (const r of rows) by.set(r.company_id, [...(by.get(r.company_id) || []), r.id]);
  if (fallbackToMd) {
    const mds = await p.employee.findMany({
      where: { status: 'ACTIVE', roles: { some: { role: { name: Roles.MD } } } },
      select: { id: true, company_id: true },
    });
    for (const m of mds) if (!by.has(m.company_id)) by.set(m.company_id, [m.id]);
  }
  return by;
}

// ---- 6. HR: attendance requests and check-in photos waiting ----
export async function remindHrQueue(d: Day) {
  const [proposals, proofs, hr] = await Promise.all([
    p.attendanceProposal.findMany({
      where: { status: 'PENDING' },
      select: { employee_id: true },
    }),
    p.attendanceCheckinProof.findMany({
      where: { review_status: 'PENDING' },
      select: { employee_id: true },
    }),
    holdersByCompany(Roles.HR_MANAGER, true),
  ]);
  const ids = [...new Set([...proposals, ...proofs].map((x) => x.employee_id))];
  const companyOf = new Map(
    (
      await p.employee.findMany({
        where: { id: { in: ids } },
        select: { id: true, company_id: true },
      })
    ).map((e) => [e.id, e.company_id]),
  );
  const count = new Map<number, { requests: number; photos: number }>();
  const bump = (empId: number, k: 'requests' | 'photos') => {
    const c = companyOf.get(empId);
    if (c === undefined) return;
    const cur = count.get(c) || { requests: 0, photos: 0 };
    cur[k]++;
    count.set(c, cur);
  };
  proposals.forEach((x) => bump(x.employee_id, 'requests'));
  proofs.forEach((x) => bump(x.employee_id, 'photos'));
  const targets: { id: number; title: string; message: string; link: string }[] = [];
  for (const [companyId, c] of count) {
    const parts = [
      c.requests ? `${c.requests} attendance request${c.requests === 1 ? '' : 's'}` : '',
      c.photos ? `${c.photos} check-in photo${c.photos === 1 ? '' : 's'}` : '',
    ].filter(Boolean);
    for (const id of hr.get(companyId) || [])
      targets.push({
        id,
        title: 'Waiting for your decision',
        message: `${parts.join(' and ')} to review.`,
        link: '/approvals?tab=attendance',
      });
  }
  return sendOnce('REMINDER_HR_QUEUE', d, targets);
}

// ---- 7. Finance: customer payments to verify, refunds due ----
export async function remindFinanceQueue(d: Day) {
  const [rows, fin] = await Promise.all([
    p.payment.groupBy({
      by: ['company_id', 'status'],
      where: { status: { in: ['PENDING', 'REFUND_DUE'] } },
      _count: { _all: true },
    }),
    holdersByCompany(Roles.FINANCE, false),
  ]);
  const targets: { id: number; title: string; message: string; link: string }[] = [];
  for (const [companyId, ids] of fin) {
    const n = (st: string) =>
      rows.find((r) => r.company_id === companyId && r.status === st)?._count._all || 0;
    const verify = n('PENDING');
    const refund = n('REFUND_DUE');
    if (!verify && !refund) continue;
    const parts = [
      verify ? `${verify} customer payment${verify === 1 ? '' : 's'} to verify` : '',
      refund ? `${refund} refund${refund === 1 ? '' : 's'} due` : '',
    ].filter(Boolean);
    for (const id of ids)
      targets.push({
        id,
        title: 'Payments waiting',
        message: `${parts.join(' and ')}.`,
        link: '/finance',
      });
  }
  return sendOnce('REMINDER_FINANCE_QUEUE', d, targets);
}

// ---- 8. Associates' leads silent past the limit: tell the CPM's manager ----
// One digest a day per manager (the notification is the marker). An
// unassigned associate, or a CPM with no active manager, goes to the MD.
export async function remindAssociateLeadsStale(d: Day) {
  const stale = await leadsPastEscalation(d.now);
  if (stale.length === 0) return 0;
  const ownerIds = [
    ...new Set(stale.map((s) => s.associate.owner_cpm_id).filter((x): x is number => !!x)),
  ];
  const owners = await p.employee.findMany({
    where: { id: { in: ownerIds } },
    select: { id: true, full_name: true, reporting_manager_id: true },
  });
  const managerIds = owners.map((o) => o.reporting_manager_id).filter((x): x is number => !!x);
  const activeManagers = new Set(
    (
      await p.employee.findMany({
        where: { id: { in: managerIds }, status: 'ACTIVE' },
        select: { id: true },
      })
    ).map((m) => m.id),
  );
  const ownerOf = new Map(owners.map((o) => [o.id, o]));
  const mds = await holdersByCompany(Roles.MD, false);
  const by = new Map<number, string[]>();
  for (const s of stale) {
    const owner = s.associate.owner_cpm_id ? ownerOf.get(s.associate.owner_cpm_id) : undefined;
    const to =
      owner?.reporting_manager_id && activeManagers.has(owner.reporting_manager_id)
        ? [owner.reporting_manager_id]
        : mds.get(s.associate.company_id) || [];
    const who = s.associate.associate_code
      ? `${s.associate.full_name} (${s.associate.associate_code})`
      : s.associate.full_name;
    const line = `${s.lead.lead_code} of ${who}, ${s.days} days${owner ? `, CPM ${owner.full_name}` : ', no CPM'}`;
    for (const id of to) by.set(id, [...(by.get(id) || []), line]);
  }
  return sendOnce(
    'ASSOCIATE_LEAD_STALE',
    d,
    [...by.entries()].map(([id, lines]) => ({
      id,
      title: `${lines.length} associate lead${lines.length === 1 ? '' : 's'} with no update`,
      message:
        lines.slice(0, 3).join('; ') + (lines.length > 3 ? ` and ${lines.length - 3} more` : ''),
      link: '/associates',
    })),
  );
}

// ---- 9. Associates: ACTIVE / DORMANT from their leads (no message) ----
export async function refreshAssociatePipelines(d: Day) {
  await refreshPipelines(d.now);
  return 0;
}

// ---- 10. Projects waiting on a person for 3+ days (once a day, until done) ----
export async function remindProjectReviews(d: Day) {
  const cutoff = new Date(d.now.getTime() - ATTENTION_OVERDUE_DAYS * DAY_MS);
  const [stale, dmHeads, mds] = await Promise.all([
    p.project.findMany({
      where: {
        status: { not: 'CANCELLED' },
        updated_at: { lte: cutoff },
        OR: [
          {
            verification_status: {
              in: ['PENDING_DM_POLISH', 'PENDING_DM_EXEC', 'PENDING_MD_APPROVAL'],
            },
          },
          { verification_status: 'REJECTED' },
        ],
      },
      select: {
        company_id: true,
        verification_status: true,
        assigned_pm_id: true,
        created_by_id: true,
        digital_marketing_executive_id: true,
      },
    }),
    holdersByCompany(Roles.DIGITAL_MARKETING_HEAD, true),
    holdersByCompany(Roles.MD, false),
  ]);
  const wait = new Map<number, { review: number; polish: number; mdStage: number; fix: number }>();
  const bump = (id: number, k: 'review' | 'polish' | 'mdStage' | 'fix') => {
    const row = wait.get(id) || { review: 0, polish: 0, mdStage: 0, fix: 0 };
    row[k]++;
    wait.set(id, row);
  };
  for (const pr of stale) {
    if (pr.verification_status === 'PENDING_DM_POLISH')
      (dmHeads.get(pr.company_id) || []).forEach((id) => bump(id, 'review'));
    else if (pr.verification_status === 'PENDING_DM_EXEC') {
      if (pr.digital_marketing_executive_id) bump(pr.digital_marketing_executive_id, 'polish');
    } else if (pr.verification_status === 'PENDING_MD_APPROVAL')
      (mds.get(pr.company_id) || []).forEach((id) => bump(id, 'mdStage'));
    else
      new Set([pr.assigned_pm_id, pr.created_by_id].filter((x): x is number => x != null)).forEach(
        (id) => bump(id, 'fix'),
      );
  }
  const targets = [...wait].map(([id, w]) => {
    const parts = [
      w.review ? `${w.review} waiting for Marketing review` : '',
      w.polish ? `${w.polish} waiting for your marketing content` : '',
      w.mdStage ? `${w.mdStage} waiting for your approval` : '',
      w.fix ? `${w.fix} rejected and waiting for your fix` : '',
    ].filter(Boolean);
    return {
      id,
      title: 'Projects waiting on you',
      message: `${parts.join(', ')} for ${ATTENTION_OVERDUE_DAYS}+ days.`,
      link: '/projects?attention=1',
    };
  });
  return sendOnce('REMINDER_PROJECT_REVIEWS', d, targets);
}

// ---- Leads referred to a partner who has not responded: tell the referrer and the MD ----
// No automatic return (owner, 2026-11-23): the people who can act are told once a day while it stays
// stale, and take the lead back by hand from the lead page.
const CP_REFERRAL_ACCEPT_HOURS = 24;
const CP_REFERRAL_IDLE_DAYS = 5;

export async function remindCpReferrals(d: Day) {
  const waitingSince = new Date(d.now.getTime() - CP_REFERRAL_ACCEPT_HOURS * 3600e3);
  const idleSince = new Date(d.now.getTime() - CP_REFERRAL_IDLE_DAYS * DAY_MS);
  const stale = await p.cpReferral.findMany({
    where: {
      OR: [
        { status: 'OFFERED', offered_at: { lte: waitingSince } },
        { status: 'ACCEPTED', last_activity_at: { lte: idleSince } },
      ],
    },
    select: {
      id: true,
      company_id: true,
      lead_id: true,
      cp_id: true,
      status: true,
      referred_by_id: true,
    },
  });
  if (stale.length === 0) return 0;
  const leads = await p.lead.findMany({
    where: { id: { in: stale.map((r: any) => r.lead_id) } },
    select: { id: true, customer_name: true, assigned_to_id: true },
  });
  const leadBy = new Map<number, any>(leads.map((l: any) => [l.id, l]));
  const mds = await holdersByCompany(Roles.MD, false);

  const per = new Map<number, string[]>();
  for (const r of stale) {
    const lead = leadBy.get(r.lead_id);
    const line = `${lead?.customer_name || 'A customer'} (${
      r.status === 'OFFERED' ? 'not accepted' : 'no activity'
    })`;
    const people = new Set<number>([r.referred_by_id, ...(mds.get(r.company_id) || [])]);
    if (lead?.assigned_to_id) people.add(lead.assigned_to_id);
    for (const id of people) per.set(id, [...(per.get(id) || []), line]);
  }
  const targets = [...per].map(([id, lines]) => ({
    id,
    title: 'Channel partner has not responded',
    message: `${lines.length} lead${lines.length === 1 ? '' : 's'} with a channel partner need${lines.length === 1 ? 's' : ''} attention: ${lines.slice(0, 3).join(', ')}${lines.length > 3 ? ` and ${lines.length - 3} more` : ''}. Open the lead to take it back.`,
    link: '/leads',
  }));
  return sendOnce('CP_REFERRAL_STALE', d, targets);
}

// ---- 10. Associates: calls still to make today (the manager), and the manager's boss when far behind ----
// "You still have 20 associates to call today." Counted the way the Today list is: associates whose call is
// due by today, minus those already followed up today, plus office visits still open.

/** Associates a manager still has to call today, how many they have already called, and open office visits. */
export async function associateCallsToday(managerId: number, d: Day) {
  const [due, touched, openVisits] = await Promise.all([
    p.associate.findMany({
      where: {
        owner_cpm_id: managerId,
        pipeline: { not: 'LEFT' },
        next_follow_up_at: { lt: d.end },
      },
      select: { id: true },
    }),
    p.associateFollowUp.findMany({
      where: { employee_id: managerId, created_at: { gte: d.start, lt: d.end } },
      select: { associate_id: true },
      distinct: ['associate_id'],
    }),
    p.associateOfficeVisit.count({
      where: {
        met_by_id: managerId,
        scheduled_at: { gte: d.start, lt: d.end },
        status: { in: ['PLANNED', 'ARRIVED'] },
      },
    }),
  ]);
  const done = new Set<number>(touched.map((t: any) => t.associate_id));
  const left = due.filter((a: any) => !done.has(a.id)).length;
  return { left, called: done.size, open_office_visits: openVisits };
}

const cpmManagers = () =>
  p.employee.findMany({
    where: { status: 'ACTIVE', roles: { some: { role: { name: Roles.CHANNEL_PARTNER_MANAGER } } } },
    select: {
      id: true,
      full_name: true,
      employee_code: true,
      company_id: true,
      reporting_manager_id: true,
    },
  });

export async function remindAssociateCalls(d: Day) {
  const targets: { id: number; title: string; message: string; link: string }[] = [];
  for (const m of await cpmManagers()) {
    const c = await associateCallsToday(m.id, d);
    if (c.left === 0 && c.open_office_visits === 0) continue;
    const parts = [
      c.left > 0 ? `${c.left} associate${c.left === 1 ? '' : 's'} still to call` : '',
      c.open_office_visits > 0
        ? `${c.open_office_visits} office visit${c.open_office_visits === 1 ? '' : 's'} to close`
        : '',
    ].filter(Boolean);
    targets.push({
      id: m.id,
      title: 'Associate calls still to make',
      message: `Today you have ${parts.join(' and ')}.${c.called ? ` You have called ${c.called} so far.` : ''}`,
      link: '/associates',
    });
  }
  return sendOnce('ASSOCIATE_CALLS_LEFT', d, targets);
}

const BEHIND_MIN_LEFT = 5;
export async function escalateAssociateCalls(d: Day) {
  const mds = await holdersByCompany(Roles.MD, false);
  const per = new Map<number, string[]>();
  for (const m of await cpmManagers()) {
    const c = await associateCallsToday(m.id, d);
    // Far behind: many left and fewer called than still waiting.
    if (c.left < BEHIND_MIN_LEFT || c.called >= c.left) continue;
    const boss = m.reporting_manager_id ? [m.reporting_manager_id] : mds.get(m.company_id) || [];
    const line = `${m.full_name || m.employee_code}: ${c.called} called, ${c.left} still waiting`;
    for (const id of boss) per.set(id, [...(per.get(id) || []), line]);
  }
  const targets = [...per].map(([id, lines]) => ({
    id,
    title: 'Associate calls are behind today',
    message: `${lines.slice(0, 4).join('; ')}${lines.length > 4 ? ` and ${lines.length - 4} more` : ''}.`,
    link: '/associates?tab=report',
  }));
  return sendOnce('ASSOCIATE_CALLS_BEHIND', d, targets);
}

// ---- 11. A lead forwarded to an associate that nobody has answered: tell who forwarded it ----
// Not accepted in a day, or accepted but silent for five days. No automatic return: they take it back by hand.
export async function remindAssociateReferrals(d: Day) {
  const waitingSince = new Date(d.now.getTime() - CP_REFERRAL_ACCEPT_HOURS * 3600e3);
  const idleSince = new Date(d.now.getTime() - CP_REFERRAL_IDLE_DAYS * DAY_MS);
  const stale = await p.associateReferral.findMany({
    where: {
      OR: [
        { status: 'OFFERED', offered_at: { lte: waitingSince } },
        { status: 'ACCEPTED', last_activity_at: { lte: idleSince } },
      ],
    },
    select: {
      id: true,
      company_id: true,
      lead_id: true,
      associate_id: true,
      status: true,
      referred_by_id: true,
    },
  });
  if (stale.length === 0) return 0;
  const [leads, assocs] = await Promise.all([
    p.lead.findMany({
      where: { id: { in: stale.map((r: any) => r.lead_id) } },
      select: { id: true, customer_name: true, assigned_to_id: true },
    }),
    p.associate.findMany({
      where: { id: { in: stale.map((r: any) => r.associate_id) } },
      select: { id: true, full_name: true, owner_cpm_id: true },
    }),
  ]);
  const leadBy = new Map<number, any>(leads.map((l: any) => [l.id, l]));
  const assocBy = new Map<number, any>(assocs.map((x: any) => [x.id, x]));
  const per = new Map<number, string[]>();
  for (const r of stale) {
    const lead = leadBy.get(r.lead_id);
    const who = assocBy.get(r.associate_id);
    const line = `${lead?.customer_name || 'A customer'} with ${who?.full_name || 'an associate'} (${
      r.status === 'OFFERED' ? 'not accepted' : 'no news'
    })`;
    const people = new Set<number>([r.referred_by_id]);
    if (lead?.assigned_to_id) people.add(lead.assigned_to_id);
    if (who?.owner_cpm_id) people.add(who.owner_cpm_id);
    for (const id of people) per.set(id, [...(per.get(id) || []), line]);
  }
  const targets = [...per].map(([id, lines]) => ({
    id,
    title: 'An associate has not answered',
    message: `${lines.length} forwarded lead${lines.length === 1 ? '' : 's'} need${lines.length === 1 ? 's' : ''} attention: ${lines.slice(0, 3).join(', ')}${lines.length > 3 ? ` and ${lines.length - 3} more` : ''}. Open the lead to take it back.`,
    link: '/leads',
  }));
  return sendOnce('ASSOCIATE_REFERRAL_STALE', d, targets);
}

export const REMINDERS: Reminder[] = [
  {
    type: 'ASSOCIATE_REFERRAL_STALE',
    from: '10:30',
    until: '17:00',
    run: remindAssociateReferrals,
  },
  { type: 'ASSOCIATE_CALLS_LEFT', from: '15:00', until: '18:30', run: remindAssociateCalls },
  { type: 'ASSOCIATE_CALLS_BEHIND', from: '17:30', until: '19:00', run: escalateAssociateCalls },
  { type: 'CP_REFERRAL_STALE', from: '10:30', until: '17:00', run: remindCpReferrals },
  { type: 'REMINDER_PROJECT_REVIEWS', from: '10:30', until: '17:00', run: remindProjectReviews },
  { type: 'REMINDER_VISITS_TODAY', from: '08:30', until: '12:00', run: remindVisitsToday },
  { type: 'REMINDER_TASKS_TODAY', from: '09:30', until: '13:00', run: remindTasksDue },
  { type: 'REMINDER_CHECK_IN', from: '10:00', until: '11:30', run: remindCheckIn },
  { type: 'REMINDER_HR_QUEUE', from: '10:30', until: '17:00', run: remindHrQueue },
  { type: 'REMINDER_FINANCE_QUEUE', from: '11:00', until: '17:00', run: remindFinanceQueue },
  { type: 'ASSOCIATE_PIPELINE', from: '09:00', until: '11:00', run: refreshAssociatePipelines },
  { type: 'ASSOCIATE_LEAD_STALE', from: '10:30', until: '17:00', run: remindAssociateLeadsStale },
  { type: 'REMINDER_DAILY_REPORT', from: '17:30', until: '23:30', run: remindDailyReport },
  { type: 'REMINDER_CHECK_OUT', from: '18:45', until: '22:30', run: remindCheckOut },
];

export function dayOf(now: Date): Day {
  const { dateString } = getISTComponents(now);
  const start = new Date(`${dateString}T00:00:00+05:30`);
  return { now, dateString, start, end: new Date(start.getTime() + DAY_MS) };
}

/** Runs every reminder whose window is open now. */
export async function reminderSweepJob(now: Date = new Date()) {
  const d = dayOf(now);
  const t = hhmm(now);
  for (const r of REMINDERS) {
    if (t < r.from || t >= r.until) continue;
    try {
      const n = await r.run(d);
      if (n > 0) logger.info(`[Reminders] ${r.type}: sent ${n}`);
    } catch (err) {
      logger.error({ err }, `[Reminders] ${r.type} failed`);
    }
  }
}
