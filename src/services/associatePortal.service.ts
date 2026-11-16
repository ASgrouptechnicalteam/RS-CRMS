import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma';
import { AppError } from './lead/errors';
import { associatePasswordFingerprint, generateAssociateToken } from '../utils/associateJwt';
import {
  ASSOCIATE_PASSWORD_RULE,
  CLOSED_LEAD,
  LOGIN_STAGES,
  maskPhone,
  tenDigits,
} from './associate.service';

// The associate's own app, read only. Every read is filtered on the signed-in
// associate's id, and a lead that is not theirs is "not found". The answers
// have a fixed shape: no notes, staff, deal values or commission figures, and
// the customer's number shows only its last 4 digits. Uplines see counts of
// their downline, never the downline's customers.

const p = prisma;

const STAGE_LABEL: Record<string, string> = {
  NEW: 'Received',
  ASSIGNED: 'Received',
  CONTACTED: 'Spoken to',
  QUALIFIED: 'Interested',
  DEMO_SCHEDULED: 'Meeting planned',
  DEMO_COMPLETED: 'Meeting done',
  SITE_VISIT_SCHEDULED: 'Site visit planned',
  SITE_VISIT_COMPLETED: 'Site visit done',
  NEGOTIATION: 'In discussion',
  BOOKING_INITIATED: 'Booking in progress',
  BOOKED: 'Booked',
  DROPPED: 'Closed',
  RECOVERED_TO_POOL: 'Closed',
};
const PAGE = 20;

type Signed = {
  id: number;
  company_id: number;
  credential: { password_hash: string; force_password_change: boolean } | null;
};

const issue = (a: Signed) =>
  generateAssociateToken({
    associateId: a.id,
    companyId: a.company_id,
    pwf: associatePasswordFingerprint(a.credential!.password_hash),
    mustChange: a.credential!.force_password_change,
  });

const profile = (a: any) => ({
  name: a.full_name,
  code: a.associate_code,
  phone: a.phone,
  email: a.email,
  designation: a.designation,
  mustChangePassword: !!a.credential?.force_password_change,
});

const leadView = (l: any) => ({
  id: l.id,
  customer_name: l.customer_name,
  customer_phone: maskPhone(l.phone),
  project: l.project?.name ?? null,
  stage: STAGE_LABEL[l.status] || 'Received',
  open: !CLOSED_LEAD.includes(l.status),
  added_on: l.created_at,
  last_update: l.updated_at,
});
const LEAD_SELECT = {
  id: true,
  customer_name: true,
  phone: true,
  status: true,
  created_at: true,
  updated_at: true,
  project: { select: { name: true } },
} as const;

export class AssociatePortalService {
  static async login(phone: string, password: string, companyId?: number) {
    const digits = tenDigits(phone);
    if (digits.length !== 10) throw new AppError(400, 'Enter your 10-digit mobile number');
    const candidates = await p.associate.findMany({
      where: {
        phone: digits,
        pipeline: { in: LOGIN_STAGES },
        credential: { isNot: null },
        ...(companyId ? { company_id: companyId } : {}),
      },
      include: { credential: true, owner: { select: { full_name: true } } },
    });
    const matches = [];
    for (const c of candidates) {
      if (await bcrypt.compare(password, c.credential!.password_hash)) matches.push(c);
    }
    if (matches.length === 0) throw new AppError(401, 'Mobile number or password is incorrect');
    if (matches.length > 1) {
      const companies = await p.company.findMany({
        where: { id: { in: matches.map((m) => m.company_id) } },
        select: { id: true, name: true },
      });
      return { chooseCompany: companies };
    }
    const a = matches[0];
    const cred = a.credential!;
    if (
      cred.force_password_change &&
      cred.temp_password_expiry &&
      cred.temp_password_expiry < new Date()
    ) {
      throw new AppError(
        401,
        'Your temporary password has expired. Please ask your Channel Partner Manager for a new one.',
      );
    }
    await p.associateCredential.update({
      where: { associate_id: a.id },
      data: { last_login_at: new Date() },
    });
    return {
      token: issue(a),
      mustChangePassword: cred.force_password_change,
      associate: profile(a),
    };
  }

  static async changePassword(a: any, current: string, next: string) {
    if (!(await bcrypt.compare(current, a.credential.password_hash))) {
      throw new AppError(400, 'Current password is incorrect');
    }
    if (!ASSOCIATE_PASSWORD_RULE.test(next)) {
      throw new AppError(400, 'Use at least 8 characters with letters and numbers');
    }
    if (current === next)
      throw new AppError(400, 'Choose a password different from the current one');
    const credential = await p.associateCredential.update({
      where: { associate_id: a.id },
      data: {
        password_hash: await bcrypt.hash(next, 12),
        force_password_change: false,
        temp_password_expiry: null,
      },
    });
    return { token: issue({ ...a, credential }) };
  }

  /** One call for the home screen: profile, lead counts, downline counts. */
  static async home(a: any) {
    const [company, total, open, team] = await Promise.all([
      p.company.findUnique({ where: { id: a.company_id }, select: { name: true } }),
      p.lead.count({ where: { associate_id: a.id } }),
      p.lead.count({ where: { associate_id: a.id, status: { notIn: CLOSED_LEAD } } }),
      AssociatePortalService.teamCounts(a),
    ]);
    return {
      associate: profile(a),
      company: company?.name ?? null,
      leads: { total, open },
      team,
    };
  }

  /** Downline counts only: people, and their leads. Never names or customers. */
  static async teamCounts(a: { id: number; company_id: number }) {
    const all = await p.associate.findMany({
      where: { company_id: a.company_id },
      select: { id: true, upline_id: true, pipeline: true },
    });
    const children = new Map<number, number[]>();
    for (const x of all) {
      if (x.upline_id) children.set(x.upline_id, [...(children.get(x.upline_id) || []), x.id]);
    }
    const direct = children.get(a.id) || [];
    const seen = new Set<number>();
    const stack = [...direct];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id) || id === a.id) continue;
      seen.add(id);
      stack.push(...(children.get(id) || []));
    }
    const ids = [...seen];
    const [leads, open] = ids.length
      ? await Promise.all([
          p.lead.count({ where: { associate_id: { in: ids } } }),
          p.lead.count({ where: { associate_id: { in: ids }, status: { notIn: CLOSED_LEAD } } }),
        ])
      : [0, 0];
    return { direct: direct.length, total: ids.length, leads, open_leads: open };
  }

  static async leads(a: { id: number }, page: number) {
    const pg = Math.max(1, Math.min(page || 1, 500));
    const [rows, total] = await Promise.all([
      p.lead.findMany({
        where: { associate_id: a.id },
        select: LEAD_SELECT,
        orderBy: { updated_at: 'desc' },
        skip: (pg - 1) * PAGE,
        take: PAGE,
      }),
      p.lead.count({ where: { associate_id: a.id } }),
    ]);
    return { leads: rows.map(leadView), total, page: pg, page_size: PAGE };
  }

  static async lead(a: { id: number }, leadId: number) {
    const l = await p.lead.findFirst({
      where: { id: leadId, associate_id: a.id },
      select: LEAD_SELECT,
    });
    if (!l) throw new AppError(404, 'Lead not found');
    return { lead: leadView(l) };
  }

  static async projects(a: { company_id: number }) {
    const rows = await p.project.findMany({
      where: {
        company_id: a.company_id,
        verification_status: 'VERIFIED',
        status: { not: 'CANCELLED' },
      },
      select: { name: true, location: true },
      orderBy: { name: 'asc' },
      take: 200,
    });
    return { projects: rows };
  }
}
