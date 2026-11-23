import { logger } from '../utils/logger';
import { Router, Response } from 'express';
import { prisma } from '../lib/prisma';
import { authenticateToken, AuthenticatedRequest, requireRole } from '../middleware/auth';
import { requireAuthz } from '../middleware/authz';
import { Roles, Permissions } from '../shared';
import { calculatePerformanceScore, PERFORMANCE_WEIGHTS } from '../services/performance-metric';
import { getISTComponents, getISTMonthRange, calculateAttendancePoints } from '../utils/time';
import { AttendanceStatusType } from '../shared';
import { isManagerOf } from '../utils/hierarchy';
import { overdueInPeriod } from '../services/taskOverdue';
import { scoreInputs } from '../services/counts/metrics';
import { aboutDaysIn, parseDateRange } from '../services/counts/period';
import { buildAchievements } from '../services/achievements';

const router = Router();
const p = prisma;

// Roles that may look at any employee's performance numbers in their company.
const METRICS_VIEWER_ROLES: string[] = [
  Roles.MD,
  Roles.ADMIN,
  Roles.HR_MANAGER,
  Roles.MARKETING_DIRECTOR,
];

/**
 * Who may read another employee's metrics: the person themselves, a manager
 * above them, or a management role -- and only inside their own company.
 * The two per-person metric endpoints used to take any employee id from any
 * logged-in user ("In production, add authorization" was still a comment).
 */
async function canViewEmployeeMetrics(
  user: NonNullable<AuthenticatedRequest['user']>,
  targetId: number,
): Promise<boolean> {
  if (targetId === user.employeeId) return true;
  const target = await p.employee.findUnique({
    where: { id: targetId },
    select: { company_id: true },
  });
  if (!target) return false;
  if (user.roles.includes(Roles.ADMIN)) return true;
  if (target.company_id !== user.companyId) return false;
  if (user.roles.some((r) => METRICS_VIEWER_ROLES.includes(r))) return true;
  return isManagerOf(user.employeeId, targetId);
}

router.post(
  '/reset-score-history',
  authenticateToken,
  requireRole([Roles.ADMIN]),
  async (req: AuthenticatedRequest, res: Response) => {
    // Destructive test helper: deletes EVERY audit event, daily report,
    // attendance log, task and score snapshot in the whole system (no company
    // filter, no confirmation). Off unless this environment variable is set
    // deliberately, and never needed on production.
    if (process.env.ALLOW_SCORE_RESET !== 'true') {
      logger.error(`Blocked score reset attempt by employee ${req.user!.employeeId}`);
      return res.status(403).json({ error: 'Score reset is disabled on this server.' });
    }
    try {
      await p.auditEvent.deleteMany({});
      await p.dailyReport.deleteMany({});
      await p.attendanceLog.deleteMany({});
      await p.task.deleteMany({});
      await p.performanceSnapshot.deleteMany({});

      return res
        .status(200)
        .json({ message: 'All account scores reset to clean 50.0 / 100+ pts successfully!' });
    } catch (error) {
      return res.status(500).json({ error: 'Failed to reset score history' });
    }
  },
);

/**
 * Computes an employee's performance score for one calendar month. Shared by
 * /my-score (current month, tiered off the prior month) and the internal
 * prior-month lookup that feeds it — the prior-month call omits
 * `tierBasisScore`, which applies no tier multiplier, so tiers only ever
 * escalate off of an already-flat, untiered figure.
 */
async function computeMonthScore(
  employeeId: number,
  startOfMonth: Date,
  endOfMonth: Date,
  tierBasisScore?: number,
) {
  // Night-job events (absence, auto check-out, missing report, cleared desk)
  // count in the month of the day they are about (services/counts/metrics.ts).
  const inputs = await scoreInputs([employeeId], {
    start: startOfMonth,
    end: new Date(endOfMonth.getTime() + 1),
  });
  return calculatePerformanceScore(inputs.get(employeeId)!, tierBasisScore);
}

router.get('/my-score', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const employeeId = req.user!.employeeId;
    const [istYear, istMonth] = getISTComponents().dateString.split('-').map(Number);
    const year = req.query.year ? Number(req.query.year) : istYear;
    const month = req.query.month ? Number(req.query.month) : istMonth;
    const { startOfMonth, endOfMonth } = getISTMonthRange(year, month);

    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYear = month === 1 ? year - 1 : year;
    const prevRange = getISTMonthRange(prevYear, prevMonth);
    const { score: tierBasisScore } = await computeMonthScore(
      employeeId,
      prevRange.startOfMonth,
      prevRange.endOfMonth,
    );

    const { score: totalScore, breakdown } = await computeMonthScore(
      employeeId,
      startOfMonth,
      endOfMonth,
      tierBasisScore,
    );

    return res.status(200).json({ employeeId, score: totalScore, breakdown });
  } catch (error) {
    logger.error('Performance score calculation error:', error);
    return res.status(500).json({ error: 'Failed to calculate performance score' });
  }
});

// Night-job events that belong to the day they are about (the run is often after midnight).
const STAMPED_ACTIONS = [
  'UNINFORMED_ABSENT',
  'ATTENDANCE_AUTO_CHECKOUT_MIDNIGHT',
  'MISSING_DAILY_REPORT',
  'COMPLETED_ALL_WORK',
  'TARGET_DAY_MET',
  'TARGET_DAY_MISSED',
  'TARGET_WEEK_MET',
  'TARGET_WEEK_MISSED',
  'TARGET_MONTH_MET',
  'TARGET_MONTH_MISSED',
];

/** When a night-job event happened: the day it is about (noon IST), else when it was written. */
const aboutTime = (e: { new_value: string | null; created_at: Date }) => {
  const day = e.new_value?.match(/"date":"(\d{4}-\d{2}-\d{2})"/)?.[1];
  return day ? new Date(`${day}T12:00:00+05:30`) : e.created_at;
};

router.get('/history', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const employeeId = req.user!.employeeId;
    const [istYear, istMonth] = getISTComponents().dateString.split('-').map(Number);
    const year = req.query.year ? Number(req.query.year) : istYear;
    const month = req.query.month ? Number(req.query.month) : istMonth;
    const { startOfMonth, endOfMonth } = getISTMonthRange(year, month);
    // Night-job events belong to the day they are about, not the (often late) run.
    const aboutThisMonth = aboutDaysIn(startOfMonth, new Date(endOfMonth.getTime() + 1));
    const events: any[] = [];

    // The six reads below are independent; they used to run one after
    // another (6 s on staging). Start them all now, await each where used.
    const completedTasksQuery = p.task.findMany({
      where: {
        assignee_id: employeeId,
        status: 'COMPLETED',
        updated_at: { gte: startOfMonth, lte: endOfMonth },
        // Keep in sync with /my-score: self-assigned tasks don't earn points,
        // so they must not appear here as if they did.
        created_by: { not: employeeId },
      },
      orderBy: { completed_at: 'desc' },
    });
    const overdueTasksQuery = p.task.findMany({
      where: { assignee_id: employeeId, ...overdueInPeriod(startOfMonth, endOfMonth) },
      orderBy: { updated_at: 'desc' },
    });
    const dailyReportsQuery = p.dailyReport.findMany({
      where: { employee_id: employeeId, submitted_at: { gte: startOfMonth, lte: endOfMonth } },
      orderBy: { submitted_at: 'desc' },
    });
    const auditEventsQuery = p.auditEvent.findMany({
      where: {
        actor_id: employeeId,
        OR: [
          {
            action: {
              in: STAMPED_ACTIONS,
            },
            ...aboutThisMonth,
          },
          {
            action: {
              notIn: STAMPED_ACTIONS,
            },
            created_at: { gte: startOfMonth, lte: endOfMonth },
          },
        ],
      },
      orderBy: { created_at: 'desc' },
    });
    const attendanceLogsQuery = p.attendanceLog.findMany({
      where: { employee_id: employeeId, check_in_at: { gte: startOfMonth, lte: endOfMonth } },
      include: { employee: { select: { employment_type: true } } },
    });
    const manualAdjustmentsQuery = p.performanceAdjustment.findMany({
      where: {
        employee_id: employeeId,
        created_at: { gte: startOfMonth, lte: endOfMonth },
      },
      include: { adjuster: { select: { full_name: true, employee_code: true } } },
    });

    events.push({
      id: 'base-50',
      action: 'INITIAL_BASE_SCORE',
      title: 'Initial Base Performance Index',
      points: 50.0,
      type: 'BOOST',
      description: 'Default starting performance index for all team members',
      timestamp: startOfMonth,
    });

    const completedTasks = await completedTasksQuery;
    for (const t of completedTasks) {
      events.push({
        id: `task-${t.id}`,
        action: 'TASK_COMPLETED',
        title: 'Task Completed',
        points: +2.0,
        type: 'BOOST',
        description: `Completed task: "${t.title}"`,
        timestamp: t.completed_at || t.updated_at,
      });
    }

    const overdueTasks = await overdueTasksQuery;
    for (const t of overdueTasks) {
      events.push({
        id: `task-od-${t.id}`,
        action: 'TASK_OVERDUE',
        title: 'Task Overdue',
        points: -1.0,
        type: 'PENALTY',
        description: `Overdue task: "${t.title}"`,
        timestamp: t.updated_at,
      });
    }

    const dailyReports = await dailyReportsQuery;
    for (const r of dailyReports) {
      events.push({
        id: `report-${r.id}`,
        action: 'DAILY_REPORT_SUBMIT',
        title: 'Daily Report Submitted',
        points: +0.5,
        type: 'BOOST',
        description: 'Submitted EOD report',
        timestamp: r.submitted_at,
      });
    }

    const auditEvents = await auditEventsQuery;
    for (const b of auditEvents) {
      if (b.action === 'DAILY_REPORT_BELOW_TARGET') {
        events.push({
          id: `bt-${b.id}`,
          action: b.action,
          title: 'Sub-Target Log Penalty',
          points: -1.0,
          type: 'PENALTY',
          description: 'Submitted daily report below assigned target',
          timestamp: b.created_at,
        });
      } else if (b.action === 'DAILY_REPORT_TARGET_EXCEEDED') {
        events.push({
          id: `te-${b.id}`,
          action: b.action,
          title: 'Target Exceeded',
          points: +0.5,
          type: 'BOOST',
          description: 'Submitted daily report exceeding targets',
          timestamp: b.created_at,
        });
      } else if (b.action === 'UNINFORMED_ABSENT') {
        events.push({
          id: `ua-${b.id}`,
          action: b.action,
          title: 'Uninformed Absence',
          points: -2.0,
          type: 'PENALTY',
          description: 'Absent without prior approval',
          timestamp: aboutTime(b),
        });
      } else if (b.action === 'ATTENDANCE_AUTO_CHECKOUT_MIDNIGHT') {
        events.push({
          id: `mc-${b.id}`,
          action: b.action,
          title: 'Forgot to Check Out',
          points: -PERFORMANCE_WEIGHTS.midnightAutoCheckoutPenalty,
          type: 'PENALTY',
          description: 'Still checked in at midnight, so the system checked you out',
          timestamp: aboutTime(b),
        });
      } else if (b.action === 'MISSING_DAILY_REPORT') {
        events.push({
          id: `mr-${b.id}`,
          action: b.action,
          title: 'Daily Report Not Sent',
          points: -PERFORMANCE_WEIGHTS.missingDailyReportPenalty,
          type: 'PENALTY',
          description: 'No end-of-day report was sent for a working day',
          timestamp: aboutTime(b),
        });
      } else if (b.action === 'COMPLETED_ALL_WORK') {
        events.push({
          id: `ca-${b.id}`,
          action: b.action,
          title: 'Finished All Work',
          points: PERFORMANCE_WEIGHTS.completedAllWorkBoost,
          type: 'BOOST',
          description: 'Every task and follow-up due that day was done',
          timestamp: aboutTime(b),
        });
      } else if (/^TARGET_(DAY|WEEK|MONTH)_(MET|MISSED)$/.test(b.action)) {
        const [, span, result] = b.action.match(/^TARGET_(DAY|WEEK|MONTH)_(MET|MISSED)$/)!;
        const pts =
          span === 'DAY'
            ? PERFORMANCE_WEIGHTS.dayTargetPoints
            : span === 'WEEK'
              ? PERFORMANCE_WEIGHTS.weekTargetPoints
              : PERFORMANCE_WEIGHTS.monthTargetPoints;
        const met = result === 'MET';
        const word = span.toLowerCase();
        events.push({
          id: `tg-${b.id}`,
          action: b.action,
          title: met
            ? `${span[0]}${word.slice(1)} Target Met`
            : `${span[0]}${word.slice(1)} Target Missed`,
          points: met ? pts : -pts,
          type: met ? 'BOOST' : 'PENALTY',
          description: met
            ? `You reached your ${word} targets`
            : `You did not reach your ${word} targets`,
          timestamp: aboutTime(b),
        });
      } else if (b.action === 'PROPERTY_BOOKED_CONTRIBUTION') {
        events.push({
          id: `bk-${b.id}`,
          action: b.action,
          title: 'Lead Converted to Booking',
          points: +10.0,
          type: 'BOOST',
          description: b.reason || 'Contributed to a Lead that converted to a Booking',
          timestamp: b.created_at,
        });
      }
    }

    const attendanceLogs = await attendanceLogsQuery;
    for (const log of attendanceLogs) {
      const ts = log.check_in_at || new Date();
      if (log.status === 'LATE') {
        events.push({
          id: `att-late-${log.id}`,
          action: 'LATE_CHECKIN',
          title: 'Late Check-In Penalty',
          points: -1.0,
          type: 'PENALTY',
          description: 'Check-in recorded late',
          timestamp: ts,
        });
      } else if (log.status === 'HALF_DAY') {
        events.push({
          id: `att-hd-${log.id}`,
          action: 'HALF_DAY_CHECKIN',
          title: 'Half Day Check-In Penalty',
          points: -1.0,
          type: 'PENALTY',
          description: 'Check-in recorded after 11:30 AM',
          timestamp: ts,
        });
      } else if (log.status === 'APPROVED_LATE') {
        // § Phase 4: an approval means "not penalized", not "still earns the
        // on-time bonus" — this used to be lumped in with PRESENT at +0.5.
        events.push({
          id: `att-apl-${log.id}`,
          action: 'APPROVED_LATE_CHECKIN',
          title: 'Approved Late Check-In',
          points: 0.0,
          type: 'NEUTRAL',
          description: 'Late check-in was approved — no gain, no penalty',
          timestamp: ts,
        });
      } else if (log.status === 'APPROVED_HALF_DAY') {
        events.push({
          id: `att-aphd-${log.id}`,
          action: 'APPROVED_HALF_DAY_CHECKIN',
          title: 'Approved Half-Day Check-In',
          points: 0.0,
          type: 'NEUTRAL',
          description: 'Half-day check-in was approved — no gain, no penalty',
          timestamp: ts,
        });
      } else if (log.status === 'PRESENT') {
        const points = calculateAttendancePoints(
          log.status as AttendanceStatusType,
          log.check_in_at,
          log.employee.employment_type || 'FULL_TIME',
        );
        const title =
          points >= 1.0
            ? 'Early Check-In'
            : points >= 0.5
              ? 'On-Time Check-In (Grace Period)'
              : 'On-Time Check-In';
        events.push({
          id: `att-present-${log.id}`,
          action: 'PRESENT_CHECKIN',
          title,
          points,
          type: points > 0 ? 'BOOST' : 'NEUTRAL',
          description: 'Checked in before the 10:30 AM cutoff',
          timestamp: ts,
        });
      }
    }

    const manualAdjustments = await manualAdjustmentsQuery;

    for (const adj of manualAdjustments) {
      events.push({
        id: `manual-adj-${adj.id}`,
        action: 'MANUAL_SCORE_ADJUSTMENT',
        title: 'Manual Score Adjustment',
        points: adj.points,
        type: adj.points > 0 ? 'BOOST' : 'PENALTY',
        description: `${adj.reason} (by ${adj.adjuster.full_name || adj.adjuster.employee_code})`,
        timestamp: adj.created_at,
      });
    }

    events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    return res.status(200).json({ events });
  } catch (error) {
    logger.error('Fetch performance history error:', error);
    return res.status(500).json({ error: 'Failed to fetch performance history' });
  }
});

router.get('/team', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const roles = req.user!.roles;
    const isMD = roles.includes(Roles.MD);
    const isAdmin = roles.includes(Roles.ADMIN);
    const isHR = roles.includes(Roles.HR_MANAGER);

    const hasTeamPermission = (req.user!.permissions || []).includes(
      Permissions.PERFORMANCE_READ_TEAM,
    );
    const canViewTeam = hasTeamPermission || isAdmin;
    if (!canViewTeam)
      return res
        .status(403)
        .json({ error: 'Access denied: Manager or above permission required.' });

    const whereClause: any = {
      company_id: req.user!.companyId,
      deleted_at: null,
      AND: [
        { roles: { none: { role: { is_invisible: true } } } },
        { roles: { none: { role: { name: Roles.ADMIN } } } },
      ],
    };
    if (!isMD && !isAdmin && !isHR) whereClause.reporting_manager_id = req.user!.employeeId;

    const [istYear, istMonth] = getISTComponents().dateString.split('-').map(Number);
    const year = req.query.year ? Number(req.query.year) : istYear;
    const month = req.query.month ? Number(req.query.month) : istMonth;
    const { startOfMonth, endOfMonth } = getISTMonthRange(Number(year), Number(month));
    // Leavers only show for a month they still worked in.
    whereClause.AND.push({
      OR: [{ status: 'ACTIVE' }, { last_working_day: { gte: startOfMonth } }],
    });

    const employees = await p.employee.findMany({
      where: whereClause,
      include: { branch: true, roles: { include: { role: true } } },
      orderBy: { employee_code: 'asc' },
    });

    // One grouped query per measure for the whole team (was 11 per person).
    const inputs = await scoreInputs(
      employees.map((e) => e.id),
      { start: startOfMonth, end: new Date(endOfMonth.getTime() + 1) },
    );
    const teamScores = employees.map((emp: any) => {
      const i = inputs.get(emp.id)!;
      const { score } = calculatePerformanceScore(i);
      return {
        id: emp.id,
        employeeCode: emp.employee_code,
        fullName: emp.full_name || emp.employee_code,
        branch: emp.branch?.name || '—',
        roles: emp.roles.map((r: any) => r.role.name),
        score,
        breakdown: {
          tasksDone: i.completedTasks,
          tasksOverdue: i.overdueTasks,
          reportsDone: i.dailyReports,
          belowTargetCount: i.belowTargetEvents,
          targetExceededEvents: i.targetExceededEvents,
          presentCount: i.presentCount,
          lateCount: i.lateCount,
          halfDayCount: i.halfDayCount,
          uninformedAbsent: i.uninformedAbsentEvents,
          midnightAutoCheckoutEvents: i.midnightAutoCheckoutEvents,
          missingDailyReportEvents: i.missingDailyReportEvents,
          propertyBookingContributions: i.propertyBookingContributions,
          manualAdjustmentsTotal: i.manualAdjustmentsTotal,
          manualAdjustmentsCount: i.manualAdjustmentsCount,
        },
        zone:
          score >= 86
            ? 'EXCELLENT'
            : score >= 66
              ? 'SAFE'
              : score >= 41
                ? 'SATISFACTORY'
                : 'DANGER',
      };
    });

    teamScores.sort((a, b) => b.score - a.score);
    return res.status(200).json({ team: teamScores, total: teamScores.length });
  } catch (error: any) {
    logger.error('Team performance error:', error);
    return res.status(500).json({ error: 'Failed to fetch team performance' });
  }
});

router.get(
  '/telecaller-metrics',
  authenticateToken,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { telecallerId, startDate, endDate } = req.query;
      // IST: the 1st of this month 00:00 by default; a date-only end covers that whole day.
      const { start, end } = parseDateRange(startDate, endDate);

      const tId = telecallerId ? parseInt(telecallerId as string, 10) : undefined;

      if (
        tId !== undefined &&
        (Number.isNaN(tId) || !(await canViewEmployeeMetrics(req.user!, tId)))
      ) {
        return res
          .status(403)
          .json({ error: 'You can only view your own or your team’s metrics.' });
      }

      const { PerformanceTrackingService } =
        await import('../services/performanceTracking.service');
      const metrics = await PerformanceTrackingService.getTelecallerMetrics(
        req.user!,
        start,
        end,
        tId,
      );

      return res.status(200).json({ metrics });
    } catch (error) {
      logger.error('Fetch telecaller metrics error:', error);
      return res.status(500).json({ error: 'Failed to fetch telecaller metrics' });
    }
  },
);

router.get('/pm-metrics', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { pmId, startDate, endDate } = req.query;
    const { start, end } = parseDateRange(startDate, endDate);

    const pId = pmId ? parseInt(pmId as string, 10) : undefined;

    if (
      pId !== undefined &&
      (Number.isNaN(pId) || !(await canViewEmployeeMetrics(req.user!, pId)))
    ) {
      return res.status(403).json({ error: 'You can only view your own or your team’s metrics.' });
    }

    const { PerformanceTrackingService } = await import('../services/performanceTracking.service');
    const metrics = await PerformanceTrackingService.getPmMetrics(req.user!, start, end, pId);

    return res.status(200).json({ metrics });
  } catch (error) {
    logger.error('Fetch pm metrics error:', error);
    return res.status(500).json({ error: 'Failed to fetch pm metrics' });
  }
});

// --- Achievements: a monthly scoreboard by role group (services/achievements.ts) ---
// ?period=this_week|this_month|last_month|this_quarter|all (default this_month).
// ?employeeId=<id> returns that one person's row, if the viewer may see them.
router.get('/achievements', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const board = await buildAchievements(
      req.user!,
      typeof req.query.period === 'string' ? req.query.period : undefined,
    );
    const one = req.query.employeeId;
    if (one && one !== 'ALL') {
      const row = board.leaderboard.find((r) => r.id === Number(one));
      if (!row) return res.status(404).json({ error: 'Employee not found' });
      return res.status(200).json({ ...row, employeeId: row.id, period: board.period });
    }
    return res.status(200).json(board);
  } catch (error) {
    logger.error('Achievements fetch error:', error);
    return res.status(500).json({ error: 'Failed to fetch achievements' });
  }
});

export default router;
