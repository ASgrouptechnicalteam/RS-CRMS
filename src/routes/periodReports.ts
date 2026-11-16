import { Router, Response } from 'express';
import { logger } from '../utils/logger';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { Roles } from '../shared';
import { getAccessibleCompanyIds } from '../authz/dataScope';
import { periodContaining, previousPeriod } from '../services/counts/period';
import { nameOf, staffOf } from '../services/counts/people';
import {
  REPORT_KINDS,
  ReportError,
  ReportKind,
  getReport,
  kindsFor,
  reportPeriod,
  resolveSubject,
} from '../services/reports/periodReports';

// Weekly and monthly reports, mounted at /api/v1/reports/period.
const router = Router();

const fail = (res: Response, error: unknown, what: string) => {
  if (error instanceof ReportError) return res.status(error.status).json({ error: error.message });
  logger.error(`${what}:`, error);
  return res.status(500).json({ error: 'Failed to load the report' });
};

// GET /reports/period/options - which reports this person may open, recent
// weeks and months, and (for the MD) whose report to open.
router.get('/options', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = req.user!;
    const kinds = kindsFor(user);
    const list = (type: 'WEEK' | 'MONTH', n: number) => {
      const out = [];
      let cur = periodContaining(type);
      for (let i = 0; i < n; i++) {
        out.push({ start: cur.startDate, label: cur.label, open: i === 0 });
        cur = previousPeriod(cur);
      }
      return out;
    };
    const top = user.roles.some((r) => [Roles.MD, Roles.ADMIN].includes(r as any));
    let people: { id: number; name: string; kinds: ReportKind[] }[] = [];
    if (top || user.roles.includes(Roles.HR_MANAGER)) {
      const staff = await staffOf(await getAccessibleCompanyIds(user));
      people = staff.map((s) => ({
        id: s.id,
        name: nameOf(s),
        kinds: [
          ...(top && s.roles.includes(Roles.SALES_MANAGER) ? (['SALES'] as ReportKind[]) : []),
          ...(top && s.roles.includes(Roles.PROJECT_MANAGER) ? (['PM'] as ReportKind[]) : []),
          ...(top && s.roles.includes(Roles.CHANNEL_PARTNER_MANAGER)
            ? (['CHANNEL'] as ReportKind[])
            : []),
          'PERSONAL' as ReportKind,
        ],
      }));
    }
    return res.status(200).json({
      kinds: kinds.map((k) => ({ kind: k, label: REPORT_KINDS[k] })),
      default: kinds[0],
      weeks: list('WEEK', 12),
      months: list('MONTH', 12),
      people,
    });
  } catch (error) {
    return fail(res, error, 'Report options error');
  }
});

// GET /reports/period?kind=COMPANY&type=WEEK|MONTH&start=YYYY-MM-DD&employeeId=
// The open period is live; a closed one is the copy saved the first time it was read.
router.get('/', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = req.user!;
    const kind = (
      typeof req.query.kind === 'string' ? req.query.kind : kindsFor(user)[0]
    ) as ReportKind;
    const type = typeof req.query.type === 'string' ? req.query.type : 'WEEK';
    const start = typeof req.query.start === 'string' ? req.query.start : undefined;
    const employeeId = req.query.employeeId ? Number(req.query.employeeId) : undefined;
    if (employeeId !== undefined && !Number.isInteger(employeeId)) {
      return res.status(400).json({ error: 'Invalid employee' });
    }
    const period = reportPeriod(type, start);
    const subject = await resolveSubject(user, kind, employeeId);
    return res.status(200).json(await getReport(subject, period));
  } catch (error) {
    return fail(res, error, 'Period report error');
  }
});

export default router;
