import { asWorkLogEntry, isWorkUpdateRole, minutesOf } from '../services/workUpdates';
import { num } from '../utils/money';
import type { Prisma } from '@prisma/client';
import { logger } from '../utils/logger';
import { Router, Response, NextFunction } from 'express';
import { TokenPayload } from '../utils/jwt';
import { prisma } from '../lib/prisma';
import { authenticateToken, AuthenticatedRequest, requireRole } from '../middleware/auth';
import { getAccessibleCompanyIds, buildEmployeeScope, visibleEmployees } from '../authz/dataScope';
import { getISTComponents, getISTMidnightInstant } from '../utils/time';
import { WORK_LOG_ACTION, parseWorkLog, WorkLogEntry, platformCounts } from './workLog';
import { associateWork } from '../services/associateWork';
import { progressFor, PLATFORM_METRICS } from '../services/targets.service';
import { CRM_ACTION, crmActionLabel } from '../middleware/recordCrmAction';
import { requireAuthz } from '../middleware/authz';
import { Roles, Permissions } from '../shared';
import { AnalyticsService } from '../services/analytics.service';
import { OPEN_TASK_STATUSES } from '../services/taskOverdue';

import { dayInfoMany, TEAM_REQUEST_TYPES } from '../services/workCalendar';
import { listTeamPlans } from '../services/dayPlan.service';

const router = Router();

const p = prisma;

/**
 * What a recorded CRM change was about, from its API path. Set from what the live records show
 * (owner, 2026-11-21, last 30 days): the Technical Manager's day is master data and project
 * entry, the MD decides attendance and listings, HR and the digital team polish projects and
 * post content, and everyone files a daily report and plan. Asking for one's own leave or
 * checking in is not work, so it is kept apart (OWN) and left out of "changes made".
 */
export type CrmGroup =
  'OWN' | 'APPROVALS' | 'FINANCE' | 'PEOPLE' | 'LISTINGS' | 'MASTER_DATA' | 'LEADS' | 'OTHER';
export const crmActionGroup = (method: string, path: string): CrmGroup => {
  const p = (path || '').replace(/^\/api\/v1/, '');
  if (
    /^\/(reports\/daily|day-plans|work-log|work-updates)(\/|$)/.test(p) ||
    /^\/attendance\/(leave-proposal|late-proposal|early-logout-proposal|field-work-proposal|wfh-proposal|comp-off-request|swap-request|duty-request|claim-request|check-in|check-out|selfie-check-in|checkout|scan)(\/|$)/.test(
      p,
    )
  )
    return 'OWN';
  if (
    /\/(approve|reject|md-approve|md-reject|md-review|review|accountant-review|verify|dm-verify-as-is)(\/|$)/.test(
      p,
    )
  )
    return 'APPROVALS';
  if (
    /^\/(expenses|expense-refunds|payments|installments|petty-cash|finance|refunds)(\/|$)/.test(p)
  )
    return 'FINANCE';
  if (/^\/master-leads(\/|$)/.test(p)) return 'MASTER_DATA';
  if (
    /^\/(employees|attendance|holidays|assets|digital-assets|meetings|work-calendar)(\/|$)/.test(p)
  )
    return 'PEOPLE';
  if (
    /^\/(properties|projects|units|pricing-rules|pricing|project-units|amenities|drafts)(\/|$)/.test(
      p,
    )
  )
    return 'LISTINGS';
  if (/^\/(leads|customers|demos|site-visits|opportunities|bookings|associates)(\/|$)/.test(p))
    return 'LEADS';
  return 'OTHER';
};

// Which kind of work a role does, for Team Today's per-role view.
const workKind = (
  roleNames: string[],
): 'CALLING' | 'SITE' | 'DIGITAL' | 'PARTNER' | 'DATA' | 'GENERAL' => {
  if (roleNames.includes(Roles.DATA_ENTRY_OPERATOR)) return 'DATA';
  if (
    roleNames.some((r) => [Roles.TELECALLER, Roles.SALES_MANAGER, Roles.AGENT].includes(r as any))
  )
    return 'CALLING';
  if (roleNames.some((r) => [Roles.PROJECT_MANAGER, Roles.INVENTORY_EXECUTIVE].includes(r as any)))
    return 'SITE';
  if (
    roleNames.some((r) =>
      [
        Roles.DIGITAL_MARKETING_EXECUTIVE,
        Roles.DIGITAL_LEAD_OPERATOR,
        Roles.DIGITAL_MARKETING_HEAD,
      ].includes(r as any),
    )
  )
    return 'DIGITAL';
  if (roleNames.includes(Roles.CHANNEL_PARTNER_MANAGER)) return 'PARTNER';
  return 'GENERAL';
};

// GET /api/v1/md/team-today?date=YYYY-MM-DD — what each employee actually did
// on a given IST day, built only from system records (attendance, CRM
// actions, tasks, site visits), with their self-typed daily report next to
// it. The MD's complaint was "employees are working but I don't know what
// they did today; I can't trust the daily reports" — this is that answer.
const dayOfPeople =
  (who: (req: AuthenticatedRequest) => Promise<Prisma.EmployeeWhereInput>) =>
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const reqDate = typeof req.query.date === 'string' ? req.query.date.slice(0, 10) : '';
      const dateString = /^\d{4}-\d{2}-\d{2}$/.test(reqDate)
        ? reqDate
        : getISTComponents(new Date()).dateString;
      const start = getISTMidnightInstant(dateString);
      const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
      const inDay = { gte: start, lt: end };

      const scope = await who(req);
      // Someone who left still shows on a day they did work, so totals add up.
      const worked = await p.leadActivity.findMany({
        where: { created_at: inDay },
        select: { actor_id: true },
        distinct: ['actor_id'],
      });
      const employees = await p.employee.findMany({
        where: {
          ...scope,
          OR: [{ status: 'ACTIVE' }, { id: { in: worked.map((w) => w.actor_id) } }],
        },
        select: {
          id: true,
          full_name: true,
          employee_code: true,
          attendance_required: true,
          company_id: true,
          weekly_off_day: true,
          employment_type: true,
          roles: { select: { role: { select: { name: true } } } },
        },
        orderBy: { full_name: 'asc' },
      });
      const ids = employees.map((e) => e.id);
      if (ids.length === 0) return res.status(200).json({ date: dateString, employees: [] });
      // Each person's own day: week off / holiday / swap / comp-off, or a duty day.
      const offToday = await dayInfoMany(employees, dateString);

      const [byType, firstLast, attendance, tasksDone, reports, visitsDone, leadsWorked] =
        await Promise.all([
          p.leadActivity.groupBy({
            by: ['actor_id', 'activity_type'],
            where: { actor_id: { in: ids }, created_at: inDay },
            _count: { _all: true },
          }),
          p.leadActivity.groupBy({
            by: ['actor_id'],
            where: {
              actor_id: { in: ids },
              created_at: inDay,
              activity_type: { notIn: ['LEAD_CREATED', 'ASSIGNED_TO_AGENT', 'ASSOCIATE_REPORT'] },
            },
            _min: { created_at: true },
            _max: { created_at: true },
          }),
          p.attendanceLog.findMany({
            where: { employee_id: { in: ids }, check_in_at: inDay },
            select: {
              employee_id: true,
              check_in_at: true,
              check_out_at: true,
              status: true,
              source: true,
            },
            orderBy: { check_in_at: 'asc' },
          }),
          p.task.groupBy({
            by: ['assignee_id'],
            where: { assignee_id: { in: ids }, status: 'COMPLETED', completed_at: inDay },
            _count: { _all: true },
          }),
          p.dailyReport.findMany({
            where: { employee_id: { in: ids }, submitted_at: inDay },
            select: { employee_id: true, call_count: true, summary: true, submitted_at: true },
          }),
          p.siteVisitBooking.groupBy({
            by: ['assigned_agent_id'],
            where: { assigned_agent_id: { in: ids }, status: 'COMPLETED', completed_at: inDay },
            _count: { _all: true },
          }),
          p.leadActivity.findMany({
            where: {
              actor_id: { in: ids },
              created_at: inDay,
              activity_type: { notIn: ['LEAD_CREATED', 'ASSIGNED_TO_AGENT', 'ASSOCIATE_REPORT'] },
            },
            select: { actor_id: true, lead_id: true },
            distinct: ['actor_id', 'lead_id'],
          }),
        ]);

      // Role-specific records. Project managers rarely call -- their day is
      // site visits and inventory upkeep; the digital team's posts/reels
      // live outside the CRM and only show up through the work log.
      const [
        pmVisitsToday,
        pmVisitsCompleted,
        pmPending,
        verifications,
        mediaUploads,
        docUploads,
        unitsAdded,
        propertiesAdded,
        workLogRows,
        earlyExits,
        leaveRequests,
        crmActionRows,
        draftsSubmitted,
        draftsPicked,
        draftsReady,
        workUpdateRows,
      ] = await Promise.all([
        p.siteVisitBooking.groupBy({
          by: ['project_manager_id'],
          where: {
            project_manager_id: { in: ids },
            scheduled_date: inDay,
            status: { not: 'CANCELLED' },
          },
          _count: { _all: true },
        }),
        p.siteVisitBooking.groupBy({
          by: ['project_manager_id'],
          where: { project_manager_id: { in: ids }, status: 'COMPLETED', completed_at: inDay },
          _count: { _all: true },
        }),
        p.siteVisitBooking.groupBy({
          by: ['project_manager_id'],
          where: {
            project_manager_id: { in: ids },
            status: { in: ['REQUESTED', 'PENDING_ACCEPTANCE', 'REASSIGNED'] },
          },
          _count: { _all: true },
        }),
        p.propertyVerificationLog.groupBy({
          by: ['actor_id'],
          where: { actor_id: { in: ids }, created_at: inDay },
          _count: { _all: true },
        }),
        p.projectMedia.groupBy({
          by: ['uploaded_by_id'],
          where: { uploaded_by_id: { in: ids }, created_at: inDay },
          _count: { _all: true },
        }),
        p.projectDocument.groupBy({
          by: ['uploaded_by_id'],
          where: { uploaded_by_id: { in: ids }, created_at: inDay },
          _count: { _all: true },
        }),
        p.projectUnit.groupBy({
          by: ['created_by_id'],
          where: { created_by_id: { in: ids }, created_at: inDay },
          _count: { _all: true },
        }),
        p.property.groupBy({
          by: ['created_by_id'],
          where: { created_by_id: { in: ids }, created_at: inDay },
          _count: { _all: true },
        }),
        p.auditEvent.findMany({
          where: { actor_id: { in: ids }, action: WORK_LOG_ACTION, created_at: inDay },
          select: { id: true, actor_id: true, new_value: true, created_at: true },
          orderBy: { created_at: 'asc' },
        }),
        // Emergency early logouts asked for today; every one waits for the MD.
        p.attendanceProposal.findMany({
          where: {
            employee_id: { in: ids },
            type: 'EARLY_CHECKOUT',
            status: { in: ['APPROVED', 'PENDING'] },
            target_date: inDay,
          },
          select: { employee_id: true, reason: true, status: true },
        }),
        // Leave asked for today or later, still waiting or already approved.
        p.attendanceProposal.findMany({
          where: {
            employee_id: { in: ids },
            type: 'LEAVE',
            status: { in: ['APPROVED', 'PENDING'] },
            target_date: { gte: start },
          },
          select: { employee_id: true, target_date: true, status: true },
          orderBy: { target_date: 'asc' },
        }),
        // Every change each person made in the CRM today (recordCrmAction).
        p.auditEvent.findMany({
          where: { actor_id: { in: ids }, action: CRM_ACTION, created_at: inDay },
          select: { actor_id: true, new_value: true, created_at: true },
          orderBy: { created_at: 'asc' },
          take: 5000,
        }),
        // Draft submissions (DraftSubmission module). Three separate numbers:
        //  submitted   - drafts this person handed in today
        //  in progress - drafts this person picked up today
        //  ready       - drafts this person finished today (real record linked)
        p.draftSubmission.groupBy({
          by: ['submitted_by'],
          where: { submitted_by: { in: ids }, created_at: inDay },
          _count: { _all: true },
        }),
        p.draftSubmission.groupBy({
          by: ['picked_by'],
          where: { picked_by: { in: ids }, picked_at: inDay },
          _count: { _all: true },
        }),
        p.draftSubmission.groupBy({
          by: ['picked_by'],
          where: { picked_by: { in: ids }, status: 'READY_IN_CRM', ready_at: inDay },
          _count: { _all: true },
        }),
        // Work updates (digital team, 2026-11-16): today's tasks, and any
        // still open from before.
        p.workUpdate.findMany({
          where: {
            employee_id: { in: ids },
            OR: [
              { started_at: inDay },
              { finished_at: inDay },
              { status: { in: ['WORKING', 'PAUSED'] } },
            ],
          },
          orderBy: { updated_at: 'desc' },
        }),
      ]);
      const countOf = (rows: any[], key: string, empId: number) =>
        rows.find((r) => r[key] === empId)?._count._all || 0;

      // A "new" call is the first call ever made to a lead, credited to whoever made it; every
      // other call is a follow-up (owner, 2026-11-21: calls are required for every role, so every
      // role shows them).
      const todaysCalls: { actor_id: number; lead_id: number }[] = await p.leadActivity.findMany({
        where: { actor_id: { in: ids }, activity_type: 'CALL_LOGGED', created_at: inDay },
        select: { actor_id: true, lead_id: true },
        take: 20000,
      });
      const calledToday = [...new Set(todaysCalls.map((c) => c.lead_id))];
      const firstCallBy = new Map<number, number>(); // lead id -> who made its first call ever
      const calledBeforeToday = new Set<number>();
      if (calledToday.length) {
        const earlier: { lead_id: number }[] = await p.leadActivity.findMany({
          where: {
            lead_id: { in: calledToday },
            activity_type: 'CALL_LOGGED',
            created_at: { lt: inDay.gte },
          },
          select: { lead_id: true },
          distinct: ['lead_id'],
        });
        for (const e of earlier) calledBeforeToday.add(e.lead_id);
        const history: { lead_id: number; actor_id: number }[] = await p.leadActivity.findMany({
          where: {
            lead_id: { in: calledToday },
            activity_type: 'CALL_LOGGED',
            created_at: { lt: end },
          },
          select: { lead_id: true, actor_id: true },
          orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
        });
        for (const h of history)
          if (!firstCallBy.has(h.lead_id)) firstCallBy.set(h.lead_id, h.actor_id);
      }
      // Leads whose very first call was today, by this person.
      const firstCallsToday = (empId: number) => {
        const todays = new Set(
          todaysCalls.filter((c) => c.actor_id === empId).map((c) => c.lead_id),
        );
        // The first call counts only when it falls today (a lead first called earlier is a follow-up).
        return [...todays].filter(
          (leadId) => firstCallBy.get(leadId) === empId && !calledBeforeToday.has(leadId),
        ).length;
      };
      // A completed visit counts once, for the person who ran it: the agent named on it, or the
      // project manager when no agent was named (never both, never the PM of a visit someone
      // else ran).
      const completedVisits: {
        assigned_agent_id: number | null;
        project_manager_id: number | null;
      }[] = await p.siteVisitBooking.findMany({
        where: {
          status: 'COMPLETED',
          completed_at: inDay,
          OR: [{ assigned_agent_id: { in: ids } }, { project_manager_id: { in: ids } }],
        },
        select: { assigned_agent_id: true, project_manager_id: true },
      });
      const visitsRunBy = (empId: number) =>
        completedVisits.filter((v) =>
          v.assigned_agent_id ? v.assigned_agent_id === empId : v.project_manager_id === empId,
        ).length;
      // Telecallers: visits they scheduled today, and visits of their leads that were completed today.
      const visitsScheduled = await p.siteVisitBooking.groupBy({
        by: ['telecaller_id'],
        where: { telecaller_id: { in: ids }, created_at: inDay, status: { not: 'CANCELLED' } },
        _count: { _all: true },
      });
      const visitsDoneForLeads = await p.siteVisitBooking.groupBy({
        by: ['telecaller_id'],
        where: { telecaller_id: { in: ids }, status: 'COMPLETED', completed_at: inDay },
        _count: { _all: true },
      });
      // Code updates (commits on the main branch) credited to each person.
      const codeUpdates = await p.codeUpdate.groupBy({
        by: ['employee_id'],
        where: { employee_id: { in: ids }, committed_at: inDay },
        _count: { _all: true },
      });
      const bookingsToday = await p.booking.groupBy({
        by: ['assigned_employee_id'],
        where: { assigned_employee_id: { in: ids }, created_at: inDay },
        _count: { _all: true },
      });

      const count = (empId: number, types: string[]) =>
        byType
          .filter((r) => r.actor_id === empId && types.includes(r.activity_type))
          .reduce((n, r) => n + r._count._all, 0);

      // Channel Partner Managers: what the Associates page recorded today (calls, agreements, visits), so
      // their day shows here even when nothing was typed in the Work Log.
      const associateByPerson = new Map(
        await Promise.all(
          employees
            .filter((e) => workKind(e.roles.map((r) => r.role.name)) === 'PARTNER')
            .map(async (e) => [e.id, await associateWork(e.id, { start, end })] as const),
        ),
      );

      const rows = employees.map((e) => {
        const att = attendance.find((a) => a.employee_id === e.id);
        const fl = firstLast.find((f) => f.actor_id === e.id);
        const report = reports.find((r) => r.employee_id === e.id);
        const calls = count(e.id, ['CALL_LOGGED']);
        const leads = leadsWorked.filter((l) => l.actor_id === e.id).length;
        const workActions = byType
          .filter(
            (r) =>
              r.actor_id === e.id &&
              !['LEAD_CREATED', 'ASSIGNED_TO_AGENT'].includes(r.activity_type),
          )
          .reduce((n, r) => n + r._count._all, 0);
        const tasks = tasksDone.find((t) => t.assignee_id === e.id)?._count._all || 0;
        const visits = visitsRunBy(e.id);

        const roleNames = e.roles.map((r) => r.role.name);
        const kind = workKind(roleNames);
        const myUpdates = workUpdateRows.filter((u) => u.employee_id === e.id);
        const workLog = [
          ...workLogRows
            .filter((w) => w.actor_id === e.id)
            .map(parseWorkLog)
            .filter((w): w is WorkLogEntry => !!w),
          // Finished work updates count like work log entries.
          ...myUpdates
            .filter(
              (u) =>
                u.status === 'DONE' &&
                u.finished_at &&
                u.finished_at >= inDay.gte &&
                u.finished_at < inDay.lt,
            )
            .map(asWorkLogEntry),
        ];
        const nowRow = myUpdates.find((u) => u.status === 'WORKING') || null;
        const workUpdates = {
          now: nowRow
            ? {
                id: nowRow.id,
                kind: nowRow.kind,
                title: nowRow.title,
                since: nowRow.resumed_at || nowRow.started_at,
                minutes: minutesOf(nowRow),
              }
            : null,
          paused: myUpdates
            .filter((u) => u.status === 'PAUSED')
            .map((u) => ({ id: u.id, kind: u.kind, title: u.title, minutes: u.worked_minutes })),
          done: myUpdates
            .filter((u) => u.status === 'DONE')
            .map((u) => ({
              id: u.id,
              kind: u.kind,
              title: u.title,
              link: u.link,
              count: u.count,
              minutes: u.worked_minutes,
              finished_at: u.finished_at,
            })),
          last_update_at: myUpdates[0]?.updated_at || null,
        };
        const site = {
          visits_today: countOf(pmVisitsToday, 'project_manager_id', e.id),
          visits_completed: visitsRunBy(e.id),
          visits_awaiting_acceptance: countOf(pmPending, 'project_manager_id', e.id),
          inventory_updates:
            countOf(verifications, 'actor_id', e.id) +
            countOf(mediaUploads, 'uploaded_by_id', e.id) +
            countOf(docUploads, 'uploaded_by_id', e.id) +
            countOf(unitsAdded, 'created_by_id', e.id) +
            countOf(propertiesAdded, 'created_by_id', e.id),
        };
        const drafts = {
          submitted: countOf(draftsSubmitted, 'submitted_by', e.id),
          in_progress: countOf(draftsPicked, 'picked_by', e.id),
          ready_in_crm: countOf(draftsReady, 'picked_by', e.id),
        };
        const crmActions = crmActionRows
          .filter((a) => a.actor_id === e.id)
          .map((a) => ({ at: a.created_at, label: crmActionLabel(a.new_value) }));
        const anyWork =
          crmActions.length > 0 ||
          drafts.submitted + drafts.in_progress + drafts.ready_in_crm > 0 ||
          workActions > 0 ||
          tasks > 0 ||
          visits > 0 ||
          workLog.length > 0 ||
          myUpdates.length > 0 ||
          site.visits_completed > 0 ||
          site.inventory_updates > 0 ||
          count(e.id, ['LEAD_CREATED']) > 0;

        const flags: string[] = [];
        const today = offToday.get(e.id);
        if (today?.offDay && att) flags.push(`Worked on ${today.label}`);
        if (today?.duty && !att) flags.push('Duty day today, not checked in yet');
        if (att && att.status !== 'ABSENT' && !anyWork) {
          flags.push(
            kind === 'CALLING'
              ? 'Present, but no work recorded in the CRM'
              : 'Present, but nothing recorded (CRM or work log)',
          );
        }
        // Leave asked for today or later (one row per working day).
        const leave = leaveRequests.filter((x) => x.employee_id === e.id);
        const dayOf = (d: Date) =>
          d.toLocaleDateString('en-IN', {
            day: 'numeric',
            month: 'short',
            timeZone: 'Asia/Kolkata',
          });
        for (const status of ['PENDING', 'APPROVED'] as const) {
          const days = leave.filter((x) => x.status === status).map((x) => dayOf(x.target_date));
          if (days.length > 0) {
            flags.push(
              status === 'PENDING'
                ? `Leave requested for ${days.join(', ')} – waiting for approval`
                : `Leave approved for ${days.join(', ')}`,
            );
          }
        }
        const early = earlyExits.find((x) => x.employee_id === e.id);
        if (early) {
          const reason = (early.reason || '').trim();
          const state = early.status === 'PENDING' ? 'waiting for MD approval' : 'approved';
          flags.push(
            `${att?.check_out_at ? 'Left early' : 'Asked to leave early'} (emergency logout, ${state}): ${reason.slice(0, 80)}`,
          );
          // The reason is about taking a day off: the early logout form was
          // used for it. Only worth saying when no leave request exists.
          const looksLikeLeave =
            /\b(leave|holiday|day off|off day|vacation)\b|\b(tomorrow|next day)\b|\b\d{1,2}(st|nd|rd|th)\b/i.test(
              reason,
            );
          if (looksLikeLeave && leave.length === 0) {
            flags.push(
              'This reads like a leave request, but it was sent as an early logout — no leave request exists. Ask them to apply under Requests → Leave.',
            );
          }
        }
        if (kind === 'SITE' && site.visits_awaiting_acceptance > 0) {
          flags.push(
            `${site.visits_awaiting_acceptance} site visit${site.visits_awaiting_acceptance === 1 ? '' : 's'} waiting for acceptance`,
          );
        }
        if (kind === 'CALLING' && report && report.call_count > calls + 5) {
          flags.push(`Report claims ${report.call_count} calls; ${calls} logged`);
        }
        // REMOTE = approved work-from-home check-in from the app; PROPOSAL =
        // created by approving a field-work request; VISIT = marked present by
        // completing a site visit with a photo and feedback. None is a hand edit.
        if (
          att &&
          !['QR_SCAN', 'REMOTE', 'FIELD', 'PROPOSAL', 'VISIT', 'APP_SELFIE'].includes(att.source)
        ) {
          flags.push('Attendance entered or edited by hand');
        }

        return {
          id: e.id,
          name: e.full_name || e.employee_code,
          employee_code: e.employee_code,
          // So the page can list part-time people after the full-time team.
          employment_type: e.employment_type || 'FULL_TIME',
          roles: roleNames,
          kind,
          site,
          drafts,
          work_log: workLog,
          associates: associateByPerson.get(e.id) || null,
          // Digital team: what they are on now, paused and finished (Work updates).
          work_updates: isWorkUpdateRole(roleNames) ? workUpdates : null,
          // Digital team: posts per platform today, from the work log (item 1).
          platform_counts: kind === 'DIGITAL' ? platformCounts(workLog) : null,
          platform_targets: [] as Awaited<ReturnType<typeof progressFor>>,
          // Everything they changed in the CRM today, oldest first.
          crm_actions: crmActions,
          attendance: att
            ? {
                check_in_at: att.check_in_at,
                check_out_at: att.check_out_at,
                status: att.status,
                source: att.source,
              }
            : null,
          attendance_required: e.attendance_required,
          // Their day off today ("Sunday (week off)", a holiday...), or null when expected at work.
          off_today: today?.offDay ? today.label : null,
          duty_today: !!today?.duty,
          crm_counts: (() => {
            const by: Record<CrmGroup, number> = {
              OWN: 0,
              APPROVALS: 0,
              FINANCE: 0,
              PEOPLE: 0,
              LISTINGS: 0,
              MASTER_DATA: 0,
              LEADS: 0,
              OTHER: 0,
            };
            for (const a of crmActionRows.filter((x) => x.actor_id === e.id)) {
              try {
                const v = JSON.parse(a.new_value || '{}');
                by[crmActionGroup(v.method || '', v.path || '')]++;
              } catch {
                by.OTHER++;
              }
            }
            return {
              // Work changes only: filing one's own report or asking for leave is not counted.
              total:
                by.APPROVALS +
                by.FINANCE +
                by.PEOPLE +
                by.LISTINGS +
                by.MASTER_DATA +
                by.LEADS +
                by.OTHER,
              approvals: by.APPROVALS,
              finance: by.FINANCE,
              people: by.PEOPLE,
              listings: by.LISTINGS,
              master_data: by.MASTER_DATA,
              leads: by.LEADS,
              other: by.OTHER,
              own: by.OWN,
            };
          })(),
          calls_logged: calls,
          calls_new: firstCallsToday(e.id),
          calls_followup: calls - firstCallsToday(e.id),
          visits_booked: count(e.id, ['SITE_VISIT_REQUESTED', 'SITE_VISIT_BOOKED']),
          visits_scheduled: countOf(visitsScheduled, 'telecaller_id', e.id),
          visits_done_for_leads: countOf(visitsDoneForLeads, 'telecaller_id', e.id),
          code_updates: countOf(codeUpdates, 'employee_id', e.id),
          bookings_today: countOf(bookingsToday, 'assigned_employee_id', e.id),
          listings_added: countOf(propertiesAdded, 'created_by_id', e.id),
          leads_worked: leads,
          contacted: count(e.id, ['CONTACTED']),
          qualified: count(e.id, ['QUALIFIED']),
          dropped: count(e.id, ['LEAD_DROPPED']),
          site_visit_actions: byType
            .filter((r) => r.actor_id === e.id && r.activity_type.startsWith('SITE_VISIT'))
            .reduce((n, r) => n + r._count._all, 0),
          visits_completed: visits,
          tasks_completed: tasks,
          leads_imported: count(e.id, ['LEAD_CREATED']),
          // Earliest / latest thing they did: lead work or any CRM change.
          first_action:
            [fl?._min.created_at, crmActions[0]?.at]
              .filter((d): d is Date => !!d)
              .sort((x, y) => x.getTime() - y.getTime())[0] || null,
          last_action:
            [fl?._max.created_at, crmActions[crmActions.length - 1]?.at]
              .filter((d): d is Date => !!d)
              .sort((x, y) => y.getTime() - x.getTime())[0] || null,
          report: report
            ? {
                submitted_at: report.submitted_at,
                reported_calls: report.call_count,
                summary: (report.summary || '').slice(0, 200),
              }
            : null,
          flags,
        };
      });

      // Digital team: their per-platform targets with progress (item 1, MD view).
      await Promise.all(
        rows
          .filter((r) => r.kind === 'DIGITAL')
          .map(async (r) => {
            const e = employees.find((x) => x.id === r.id)!;
            const all = await progressFor({
              id: e.id,
              company_id: e.company_id,
              roles: r.roles,
            });
            r.platform_targets = all.filter((t) => PLATFORM_METRICS[t.metric]);
          }),
      );

      // Each lead once, however many people touched it (the per-person counts add up to more).
      const leadsWorkedTotal = new Set(leadsWorked.map((l: any) => l.lead_id)).size;
      return res
        .status(200)
        .json({ date: dateString, employees: rows, leads_worked_total: leadsWorkedTotal });
    } catch (error) {
      logger.error('Team today error:', error);
      return res.status(500).json({ error: "Failed to load the team's day" });
    }
  };

router.get(
  '/team-today',
  authenticateToken,
  requireRole([Roles.MD, Roles.ADMIN, Roles.HR_MANAGER]),
  dayOfPeople((req) => buildEmployeeScope(req.user!)),
);

// GET /api/v1/md/tomorrow-plans - what each person plans to do on their next working day
// (the plan they must write before logging out); ?day=today shows today's plan instead,
// with what has been ticked off. MD, Admin and HR; read only.
router.get(
  '/tomorrow-plans',
  authenticateToken,
  requireRole([Roles.MD, Roles.ADMIN, Roles.HR_MANAGER]),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const day = req.query.day === 'today' ? 'today' : 'tomorrow';
      return res.json(await listTeamPlans(await buildEmployeeScope(req.user!), day));
    } catch (error) {
      logger.error('Tomorrow plans error:', error);
      return res.status(500).json({ error: "Could not load tomorrow's plans" });
    }
  },
);

// GET /api/v1/md/my-work?date=YYYY-MM-DD - the same record, for the person's own
// day only. Anyone signed in; it never returns anybody else.
router.get(
  '/my-work',
  authenticateToken,
  dayOfPeople(async (req) => ({ id: req.user!.employeeId })),
);

/**
 * Everything waiting on the MD, in one place: per section a count, its five
 * oldest items and the screen where it is acted on. Shared by the Approvals
 * page and the MD dashboard (GET /md/overview), so the numbers always match.
 */
export async function buildApprovalsInbox(user: TokenPayload) {
  const isAdmin = user.roles.includes(Roles.ADMIN);
  const companyIds = await getAccessibleCompanyIds(user);
  const co = isAdmin ? {} : { company_id: { in: companyIds } };
  // AttendanceProposal has no employee relation -- filter by employee ids.
  const companyEmployees = await p.employee.findMany({
    where: isAdmin ? {} : { company_id: { in: companyIds } },
    select: { id: true, full_name: true, employee_code: true },
  });
  const nameOf = new Map(companyEmployees.map((e) => [e.id, e.full_name || e.employee_code]));
  const empCo = isAdmin ? {} : { employee_id: { in: companyEmployees.map((e) => e.id) } };
  const leadCo = isAdmin ? {} : { lead: { company_id: { in: companyIds } } };
  const now = new Date();
  const take = 5;
  const visitWhere = { status: { in: ['REQUESTED', 'PENDING_ACCEPTANCE'] as any }, ...leadCo };

  const [
    properties,
    propertiesN,
    projects,
    projectsN,
    bookings,
    bookingsN,
    refunds,
    refundsN,
    proposals,
    proposalsN,
    visits,
    visitsN,
    complaints,
    complaintsN,
    budgets,
  ] = await Promise.all([
    p.property.findMany({
      where: { ...co, status: 'PENDING_MD_APPROVAL' },
      select: { id: true, title: true, property_code: true, updated_at: true },
      orderBy: { updated_at: 'asc' },
      take,
    }),
    p.property.count({ where: { ...co, status: 'PENDING_MD_APPROVAL' } }),
    p.project.findMany({
      where: { ...co, verification_status: 'PENDING_MD_APPROVAL' },
      select: { id: true, name: true, project_code: true, updated_at: true },
      orderBy: { updated_at: 'asc' },
      take,
    }),
    p.project.count({ where: { ...co, verification_status: 'PENDING_MD_APPROVAL' } }),
    p.booking.findMany({
      where: { ...co, form_status: 'SUBMITTED' },
      select: { id: true, booking_code: true, updated_at: true },
      orderBy: { updated_at: 'asc' },
      take,
    }),
    p.booking.count({ where: { ...co, form_status: 'SUBMITTED' } }),
    p.expenseRefund.findMany({
      where: { ...co, status: 'ACCOUNTANT_APPROVED' },
      select: {
        id: true,
        amount: true,
        purpose: true,
        created_at: true,
        employee: { select: { full_name: true } },
      },
      orderBy: { created_at: 'asc' },
      take,
    }),
    p.expenseRefund.count({ where: { ...co, status: 'ACCOUNTANT_APPROVED' } }),
    p.attendanceProposal.findMany({
      // Leave, late, early, work from home and field work. Duty days, comp-offs, swaps and attendance
      // claims are the "duty" section below: counted once, on their own.
      where: { status: 'PENDING', type: { notIn: [...TEAM_REQUEST_TYPES] }, ...empCo },
      select: {
        id: true,
        type: true,
        target_date: true,
        created_at: true,
        employee_id: true,
      },
      orderBy: [{ created_at: 'asc' }, { target_date: 'asc' }],
      // All pending rows: a multi-day leave is one row per day and is
      // grouped below so it counts (and shows) as one request.
    }),
    Promise.resolve(0),
    // Visits nobody on the PM side has accepted yet, including ones whose
    // date has already gone by (production: every visit ever booked).
    p.siteVisitBooking.findMany({
      where: visitWhere,
      select: {
        id: true,
        booking_code: true,
        scheduled_date: true,
        lead: { select: { customer_name: true } },
        project_manager: { select: { full_name: true } },
      },
      orderBy: { scheduled_date: 'asc' },
      take,
    }),
    p.siteVisitBooking.count({ where: visitWhere }),
    p.complaint.findMany({
      where: { ...co, status: { in: ['OPEN', 'REOPENED'] } },
      select: { id: true, title: true, created_at: true },
      orderBy: { created_at: 'asc' },
      take,
    }),
    p.complaint.count({ where: { ...co, status: { in: ['OPEN', 'REOPENED'] } } }),
    // Petty cash budgets the accountant sent for approval (2026-11-16).
    p.monthlyBudget.findMany({
      where: { ...co, status: 'SUBMITTED' },
      select: {
        id: true,
        month: true,
        submitted_at: true,
        created_at: true,
        lines: { select: { amount: true } },
      },
      orderBy: { submitted_at: 'asc' },
    }),
  ]);

  // Tasks past their deadline (count only; the Tasks page lists them).
  const overdueTasksN = await p.task.count({
    where: {
      ...(isAdmin ? {} : { assignee: { company_id: { in: companyIds } } }),
      OR: [{ status: 'OVERDUE' }, { status: { in: OPEN_TASK_STATUSES }, target_date: { lt: now } }],
    },
  });

  const oldestOverdue = overdueTasksN
    ? await p.task.findFirst({
        where: {
          ...(isAdmin ? {} : { assignee: { company_id: { in: companyIds } } }),
          OR: [
            { status: 'OVERDUE' },
            { status: { in: OPEN_TASK_STATUSES }, target_date: { lt: now } },
          ],
        },
        select: { target_date: true },
        orderBy: { target_date: 'asc' },
      })
    : null;

  // Early logouts approved on the spot that nobody has looked at yet.
  const earlyWhere = {
    type: 'EARLY_CHECKOUT',
    status: 'APPROVED',
    reviewed_by: null,
    ...empCo,
  };
  const [earlyReviews, earlyReviewsN] = await Promise.all([
    p.attendanceProposal.findMany({
      where: earlyWhere,
      select: { id: true, target_date: true, employee_id: true, reason: true },
      orderBy: { target_date: 'desc' },
      take,
    }),
    p.attendanceProposal.count({ where: earlyWhere }),
  ]);

  // Duty days, comp-offs, swaps and attendance claims, plus phone check-in photos waiting for a decision.
  const [dutyRequestsN, dutyCheckinsN] = await Promise.all([
    p.attendanceProposal.count({
      where: { status: 'PENDING', type: { in: [...TEAM_REQUEST_TYPES] }, ...empCo },
    }),
    p.attendanceCheckinProof.count({ where: { review_status: 'PENDING', ...empCo } }),
  ]);

  type ProposalRow = (typeof proposals)[number];
  const proposalGroups: { first: ProposalRow; last: ProposalRow; days: number }[] = [];
  const groupIndex = new Map<string, number>();
  for (const x of proposals) {
    const key = x.type === 'LEAVE' ? `${x.employee_id}:${x.created_at.getTime()}` : `id:${x.id}`;
    const at = groupIndex.get(key);
    if (at === undefined) {
      groupIndex.set(key, proposalGroups.length);
      proposalGroups.push({ first: x, last: x, days: 1 });
    } else {
      proposalGroups[at].last = x;
      proposalGroups[at].days++;
    }
  }
  void proposalsN;

  const sections = [
    {
      key: 'properties',
      label: 'Properties to approve',
      link: '/action-center',
      count: propertiesN,
      items: properties.map((x) => ({
        id: x.id,
        title: x.title,
        subtitle: x.property_code,
        since: x.updated_at,
      })),
    },
    {
      key: 'projects',
      label: 'Projects to approve',
      link: '/action-center',
      count: projectsN,
      items: projects.map((x) => ({
        id: x.id,
        title: x.name,
        subtitle: x.project_code,
        since: x.updated_at,
      })),
    },
    {
      key: 'bookings',
      label: 'Booking forms to approve',
      link: '/action-center',
      count: bookingsN,
      items: bookings.map((x) => ({ id: x.id, title: x.booking_code, since: x.updated_at })),
    },
    {
      key: 'refunds',
      label: 'Expense refunds (checked by accountant)',
      link: '/finance',
      count: refundsN,
      items: refunds.map((x) => ({
        id: x.id,
        title: `Rs ${num(x.amount).toLocaleString('en-IN')} - ${x.employee?.full_name || ''}`,
        subtitle: x.purpose,
        since: x.created_at,
      })),
    },
    {
      key: 'leave',
      label: 'Leave & attendance requests',
      link: '/approvals',
      count: proposalGroups.length,
      items: proposalGroups.slice(0, take).map((g) => ({
        id: g.first.id,
        title: `${nameOf.get(g.first.employee_id) || ''} - ${g.first.type.replace(/_/g, ' ').toLowerCase()}`,
        subtitle:
          g.days > 1
            ? `${getISTComponents(g.first.target_date).dateString} to ${getISTComponents(g.last.target_date).dateString} (${g.days} days)`
            : `for ${getISTComponents(g.first.target_date).dateString}`,
        since: g.first.created_at,
      })),
    },
    {
      key: 'duty',
      label: 'Duty days, comp-offs and check-ins',
      link: '/approvals?tab=attendance&sub=duty',
      count: dutyRequestsN + dutyCheckinsN,
      items: [],
    },
    {
      key: 'early_reviews',
      label: 'Early logouts approved automatically, to review',
      link: '/approvals',
      count: earlyReviewsN,
      items: earlyReviews.map((x) => ({
        id: x.id,
        title: `${nameOf.get(x.employee_id) || ''} - left early`,
        subtitle: `${getISTComponents(x.target_date).dateString}: ${(x.reason || '').slice(0, 60)}`,
        since: x.target_date,
      })),
    },
    {
      key: 'site_visits',
      label: 'Site visits not accepted by PM',
      link: '/site-visits?focus=WAITING_PM',
      count: visitsN,
      items: visits.map((x) => ({
        id: x.id,
        title: `${x.booking_code} - ${x.lead?.customer_name || ''}`,
        subtitle: `PM: ${x.project_manager?.full_name || 'none'}`,
        since: x.scheduled_date,
        overdue: x.scheduled_date < now,
      })),
    },
    {
      key: 'budgets',
      label: 'Petty cash budgets to approve',
      link: '/petty-cash',
      count: budgets.length,
      items: budgets.slice(0, take).map((x) => ({
        id: x.id,
        title: `Budget for ${x.month}`,
        subtitle: `Rs ${num(x.lines.reduce((n, l) => n + num(l.amount), 0)).toLocaleString('en-IN')}`,
        since: x.submitted_at || x.created_at,
      })),
    },
    {
      key: 'complaints',
      label: 'Open complaints',
      link: '/complaints',
      count: complaintsN,
      items: complaints.map((x) => ({ id: x.id, title: x.title, since: x.created_at })),
    },
    {
      key: 'overdue_tasks',
      label: 'Overdue tasks',
      // Opens only the overdue tasks, not every task.
      link: '/tasks?tab=team_tasks&status=OVERDUE',
      count: overdueTasksN,
      items: oldestOverdue
        ? [{ id: 0, title: 'Oldest overdue task', since: oldestOverdue.target_date }]
        : [],
    },
  ];

  const withOldest = sections.map((sec) => ({
    ...sec,
    // Oldest waiting item (visits: the visit date), for "oldest 3 days".
    oldest_at:
      sec.items
        .map((i: { since: Date }) => i.since)
        .sort((x: Date, y: Date) => x.getTime() - y.getTime())[0] || null,
  }));
  // Overdue tasks are not approvals (owner, 2026-11-14): kept out of the
  // approvals page and its count, still shown on the MD dashboard.
  const approvals = withOldest.filter((sec) => sec.key !== 'overdue_tasks');
  return {
    total: approvals.reduce((n, sec) => n + sec.count, 0),
    sections: approvals,
    overdue_tasks: withOldest.find((sec) => sec.key === 'overdue_tasks')!,
  };
}

// GET /api/v1/md/approvals-inbox — everything waiting on the MD, in one place.
router.get(
  '/approvals-inbox',
  authenticateToken,
  requireRole([Roles.MD, Roles.ADMIN]),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      return res.status(200).json(await buildApprovalsInbox(req.user!));
    } catch (error) {
      logger.error('Approvals inbox error:', error);
      return res.status(500).json({ error: 'Failed to load approvals' });
    }
  },
);

// GET /api/v1/md/leads-no-activity - open leads with no activity for 2+ / 5+
// days, by owner. Shown on the HR dashboard (HR follows up with the people),
// no longer on the MD dashboard (owner, 2026-11-14).
router.get(
  '/leads-no-activity',
  authenticateToken,
  requireRole([Roles.MD, Roles.ADMIN, Roles.HR_MANAGER]),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { leadsAtRisk } = await import('../services/counts/metrics');
      const companyIds = await getAccessibleCompanyIds(req.user!);
      const risk = await leadsAtRisk(companyIds);
      const owners = await p.employee.findMany({
        where: { id: { in: risk.by_owner.map((r) => r.owner_id) } },
        select: { id: true, full_name: true, employee_code: true, status: true },
      });
      const byId = new Map(owners.map((o) => [o.id, o]));
      return res.status(200).json({
        stale_2: risk.stale_2,
        stale_5: risk.stale_5,
        by_owner: risk.by_owner.map((r) => {
          const o = byId.get(r.owner_id);
          return {
            ...r,
            name: o ? o.full_name || o.employee_code : `#${r.owner_id}`,
            employee_code: o?.employee_code || null,
            left: o ? o.status !== 'ACTIVE' : false,
          };
        }),
      });
    } catch (error) {
      logger.error('Leads with no activity error:', error);
      return res.status(500).json({ error: 'Failed to load leads with no activity' });
    }
  },
);

// GET /api/v1/md/overview?period=today|week|month|all - the MD dashboard in one
// request (services/mdOverview.ts).
router.get(
  '/overview',
  authenticateToken,
  requireRole([Roles.MD, Roles.ADMIN]),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { mdOverview } = await import('../services/mdOverview');
      const period = typeof req.query.period === 'string' ? req.query.period : 'today';
      return res.status(200).json(await mdOverview(req.user!, period));
    } catch (error) {
      logger.error('MD overview error:', error);
      return res.status(500).json({ error: 'Failed to load the overview' });
    }
  },
);

// GET /api/v1/md/employees - List employees for MD Control (Admin filtered out)
router.get(
  '/employees',
  authenticateToken,
  requireAuthz(Permissions.EMPLOYEES_READ),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const employees = await p.employee.findMany({
        where: {
          // Packet D (15-16): company-scoped to req.user.companyId
          company_id: req.user!.companyId,
          // Leavers only on request (?include_left=1).
          ...(req.query.include_left === '1' ? {} : { status: 'ACTIVE' }),
          // Filter out Admin or invisible system roles per SDD Golden Rule #2
          roles: {
            none: {
              role: {
                is_invisible: true,
              },
            },
          },
          // ...and the system placeholder, which has no role at all.
          ...visibleEmployees,
        },
        include: {
          company: true,
          branch: true,
          roles: {
            include: {
              role: true,
            },
          },
        },
        orderBy: { id: 'asc' },
      });

      const formatted = employees.map((emp: any) => ({
        id: emp.id,
        employeeCode: emp.employee_code,
        fullName: emp.full_name || emp.employee_code,
        company: emp.company.name,
        branch: emp.branch?.name || 'All Branches',
        roles: emp.roles.map((r: any) => r.role.name),
        status: emp.status,
        attendanceRequired: emp.attendance_required,
        firstLoginDone: emp.first_login_done,
      }));

      return res.status(200).json({ employees: formatted });
    } catch (error) {
      logger.error('MD employees fetch error:', error);
      return res.status(500).json({ error: 'Failed to fetch employee list' });
    }
  },
);

// PATCH /api/v1/md/employees/:id/attendance-requirement - Toggle attendance requirement
router.patch(
  '/employees/:id/attendance-requirement',
  authenticateToken,
  requireAuthz(Permissions.EMPLOYEES_UPDATE),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const targetId = parseInt(req.params.id, 10);
      const { attendanceRequired } = req.body;

      if (typeof attendanceRequired !== 'boolean') {
        return res.status(400).json({ error: 'attendanceRequired must be a boolean' });
      }

      const existing = await p.employee.findUnique({
        where: { id: targetId },
        include: { roles: { include: { role: true } } },
      });

      if (!existing) {
        return res.status(404).json({ error: 'Employee not found' });
      }

      // Safeguard: Never modify invisible Admin
      if (existing.roles.some((r: any) => r.role.is_invisible)) {
        return res.status(403).json({ error: 'Cannot modify Admin technical account' });
      }

      const updated = await p.employee.update({
        where: { id: targetId },
        data: { attendance_required: attendanceRequired },
      });

      const actorId = req.user?.employeeId || 1;

      // Write Audit Event per SDD Golden Rule #6
      await p.auditEvent.create({
        data: {
          actor_id: actorId,
          action: 'TOGGLE_ATTENDANCE_REQUIREMENT',
          entity_type: 'EMPLOYEE',
          entity_id: targetId,
          old_value: JSON.stringify({ attendance_required: existing.attendance_required }),
          new_value: JSON.stringify({ attendance_required: updated.attendance_required }),
        },
      });

      return res.status(200).json({
        message: `Updated attendance requirement for ${updated.employee_code} to ${updated.attendance_required}`,
        employeeId: updated.id,
        attendanceRequired: updated.attendance_required,
      });
    } catch (error: any) {
      next(error);
    }
  },
);

// GET /api/v1/md/executive-metrics - Real DB Metrics Aggregator for MD Executive Dashboard
// Delegates to the centralized AnalyticsService (Phase 16 Packet B extraction) so the
// KPI calculations are shared with /api/v1/analytics/kpis. The flat response contract
// below is preserved EXACTLY (same field names) - this is behavior-preserving.
router.get(
  '/executive-metrics',
  authenticateToken,
  requireAuthz(Permissions.ADMIN_SYSTEM_METRICS),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const companyId = req.user?.companyId || 1;
      const metrics = await AnalyticsService.getExecutiveMetrics(companyId);
      return res.status(200).json(metrics);
    } catch (error: any) {
      logger.error('Fetch executive metrics error:', error);
      return res.status(500).json({ error: 'Failed to fetch executive metrics' });
    }
  },
);

// GET /api/v1/md/recent-activity - Portal-wide activity feed for the MD dashboard
router.get(
  '/recent-activity',
  authenticateToken,
  requireAuthz(Permissions.ADMIN_SYSTEM_METRICS),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const companyId = req.user?.companyId || 1;
      const activity = await AnalyticsService.getRecentActivity(companyId);
      return res.status(200).json({ activity });
    } catch (error: any) {
      logger.error('Fetch recent activity error:', error);
      return res.status(500).json({ error: 'Failed to fetch recent activity' });
    }
  },
);

// GET /api/v1/md/lead-pipeline-counts - Per-stage lead counts (NEW..BOOKED) for
// the MD/Admin dashboard's pipeline tabs. Polled by the frontend for a
// near-real-time count without requiring a manual page refresh.
router.get(
  '/lead-pipeline-counts',
  authenticateToken,
  requireAuthz(Permissions.ADMIN_SYSTEM_METRICS),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const companyId = req.user?.companyId || 1;
      const stages = await AnalyticsService.getLeadPipelineCounts(companyId);
      return res.status(200).json({ stages });
    } catch (error: any) {
      logger.error('Fetch lead pipeline counts error:', error);
      return res.status(500).json({ error: 'Failed to fetch lead pipeline counts' });
    }
  },
);

export default router;
