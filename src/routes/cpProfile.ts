import { Router, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { prisma } from '../lib/prisma';
import { authenticateToken, AuthenticatedRequest, requireRole } from '../middleware/auth';
import { Roles } from '../shared';
import { getAccessibleCompanyIds } from '../authz/dataScope';
import { decryptData, encryptData } from '../utils/crypto';
import { generateCpToken } from '../utils/cpJwt';
import { notifyEmployee } from '../utils/notifyEmployee';
import { logger } from '../utils/logger';
import { requireCp, requireOwner, CpRequest } from './cp';

/**
 * A channel partner's own account (2026-11-26), on the same CRM server and database:
 *  - change password (owner and team members; our employees on a partner team use their CRM password),
 *  - "My profile": the details from their registration form. Contact details are free to change. Bank, PAN and
 *    Aadhaar can be filled in when blank; changing a value that is already there needs the password again and waits
 *    for HR (or the MD/Admin) to confirm. Stored encrypted; screens only ever see the last digits.
 */
export const cpProfileRouter = Router();
const p = prisma as any;

type Handler = (req: CpRequest, res: Response) => Promise<unknown>;
const handle = (fn: Handler) => async (req: CpRequest, res: Response, next: NextFunction) => {
  try {
    await fn(req, res);
  } catch (e) {
    next(e);
  }
};

const passwordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req: any) => `cp-pw:${req.cp?.id}:${req.cp?.user?.id ?? 0}`,
  message: { error: 'Too many tries. Please wait 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const PasswordSchema = z.object({
  current_password: z.string().min(1, 'Enter your current password').max(200),
  new_password: z.string().min(8, 'The new password needs at least 8 characters').max(100),
});

cpProfileRouter.post(
  '/me/password',
  requireCp,
  passwordLimiter,
  handle(async (req, res) => {
    const body = PasswordSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: body.error.issues[0]?.message });
    const { current_password, new_password } = body.data;
    if (req.cp!.staff) {
      return res.status(400).json({
        error: 'You sign in with your employee code. Change your password in the CRM.',
      });
    }
    if (current_password === new_password) {
      return res.status(400).json({ error: 'Choose a password you are not using now.' });
    }
    const cpId = req.cp!.id;
    const member = req.cp!.user
      ? await p.cpUser.findUnique({ where: { id: req.cp!.user.id } })
      : null;
    const account =
      member ??
      (await p.employee.findUnique({
        where: { id: cpId },
        select: { id: true, password_hash: true, token_version: true },
      }));
    if (!account || !(await bcrypt.compare(current_password, account.password_hash))) {
      return res.status(400).json({ error: 'Your current password is not right.' });
    }
    const tv = account.token_version + 1; // signs out other devices
    const password_hash = await bcrypt.hash(new_password, 12);
    if (member) {
      await p.cpUser.update({
        where: { id: member.id },
        data: { password_hash, token_version: tv },
      });
    } else {
      await p.employee.update({
        where: { id: cpId },
        data: { password_hash, token_version: tv, first_login_done: true },
      });
    }
    await p.auditEvent
      .create({
        data: {
          actor_id: cpId,
          action: 'CP_PASSWORD_CHANGED',
          entity_type: 'EMPLOYEE',
          entity_id: cpId,
          reason: member
            ? `Team member ${member.full_name} changed their password`
            : 'Partner changed their password',
        },
      })
      .catch(() => undefined);
    const token = generateCpToken({
      employeeId: cpId,
      companyId: req.cp!.company_id,
      tv,
      ...(member ? { uid: member.id } : {}),
    } as any);
    return res.status(200).json({ ok: true, token });
  }),
);

// ── My profile ────────────────────────────────────────────────

const blank = <T extends z.ZodTypeAny>(s: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), s.optional());
const compact = (re: RegExp, upper: boolean, message: string) =>
  blank(
    z
      .string()
      .transform((v) => {
        const c = v.replace(/[\s-]/g, '');
        return upper ? c.toUpperCase() : c;
      })
      .pipe(z.string().regex(re, message)),
  );

const ProfileSchema = z.object({
  whatsapp: compact(/^(\+?91)?[6-9]\d{9}$/, false, 'Enter a 10-digit WhatsApp number'),
  email: blank(z.string().trim().toLowerCase().email('Enter a valid email').max(120)),
  address: blank(z.string().trim().min(5, 'Enter your full address').max(500)),
  occupation: blank(z.string().trim().max(80)),
  photo: blank(z.string().max(600_000)),
  photo_thumb: blank(z.string().max(60_000)),
  bank_name: blank(z.string().trim().min(2).max(80)),
  bank_branch: blank(z.string().trim().max(80)),
  bank_account: compact(/^\d{6,20}$/, false, 'Bank account number should be 6 to 20 digits'),
  ifsc: compact(/^[A-Z]{4}0[A-Z0-9]{6}$/, true, 'IFSC looks wrong. Example: SBIN0001234'),
  pan: compact(/^[A-Z]{5}\d{4}[A-Z]$/, true, 'PAN looks wrong. Example: ABCDE1234F'),
  aadhaar: compact(/^[2-9]\d{11}$/, false, 'Aadhaar should be 12 digits'),
  current_password: blank(z.string().max(200)),
});

/** "••••••1234" */
const tail = (v: string | null | undefined) => (v ? `••••${v.slice(-4)}` : null);
const dec = (v: string | null | undefined) => {
  try {
    return v ? decryptData(v) : null;
  } catch {
    return null;
  }
};

const EMPLOYEE_FIELDS = {
  id: true,
  employee_code: true,
  full_name: true,
  phone: true,
  email: true,
  whatsapp_number: true,
  current_address: true,
  company_id: true,
  password_hash: true,
  bank_name: true,
  bank_branch: true,
  bank_ifsc: true,
  bank_account_number: true,
  pan_number: true,
  aadhaar_number: true,
} as const;

const loadProfile = async (cpId: number) => {
  const [e, form] = await Promise.all([
    p.employee.findUnique({ where: { id: cpId }, select: EMPLOYEE_FIELDS }),
    p.cpApplication.findFirst({ where: { employee_id: cpId }, orderBy: { id: 'desc' } }),
  ]);
  return { e, form };
};

const profileView = async (cpId: number) => {
  const { e, form } = await loadProfile(cpId);
  const pending = await p.cpDetailsChange.findFirst({
    where: { cp_id: cpId, status: 'PENDING' },
    orderBy: { id: 'desc' },
  });
  const account = dec(e.bank_account_number);
  const pan = dec(e.pan_number);
  const aadhaar = dec(e.aadhaar_number);
  return {
    sign_in_id: e.employee_code,
    full_name: e.full_name,
    phone: e.phone,
    whatsapp: e.whatsapp_number ?? form?.whatsapp ?? null,
    email: e.email ?? form?.email ?? null,
    address: e.current_address ?? form?.address ?? null,
    occupation: form?.occupation ?? null,
    photo_thumb: form?.photo_thumb ? `data:image/jpeg;base64,${form.photo_thumb}` : null,
    can_edit_photo: !!form,
    bank: {
      filled: !!account,
      bank_name: dec(e.bank_name),
      bank_branch: dec(e.bank_branch),
      ifsc: dec(e.bank_ifsc),
      account_masked: tail(account),
    },
    pan_masked: tail(pan),
    aadhaar_masked: tail(aadhaar),
    waiting: pending
      ? { id: pending.id, summary: pending.summary, sent_at: pending.created_at }
      : null,
  };
};

cpProfileRouter.get(
  '/me/profile',
  requireCp,
  requireOwner,
  handle(async (req, res) =>
    res
      .status(200)
      // Our own employees (Full access) may look, never change.
      .json({ ...(await profileView(req.cp!.id)), can_edit: !req.cp!.staff }),
  ),
);

/** Writes the sensitive values (plain in, encrypted at rest) to the partner's account and their form. */
export async function applySensitive(cpId: number, v: Record<string, string | undefined>) {
  const emp: Record<string, unknown> = {};
  const form: Record<string, unknown> = {};
  if (v.bank_account) {
    emp.bank_account_number = encryptData(v.bank_account);
    form.bank_account_enc = emp.bank_account_number;
  }
  if (v.bank_name) {
    emp.bank_name = encryptData(v.bank_name);
    form.bank_name = v.bank_name;
  }
  if (v.bank_branch !== undefined) {
    emp.bank_branch = encryptData(v.bank_branch);
    form.bank_branch = v.bank_branch;
  }
  if (v.ifsc) {
    emp.bank_ifsc = encryptData(v.ifsc);
    form.ifsc = v.ifsc;
  }
  if (v.pan) {
    emp.pan_number = encryptData(v.pan);
    form.pan_enc = emp.pan_number;
  }
  if (v.aadhaar) {
    emp.aadhaar_number = encryptData(v.aadhaar);
    form.aadhaar_enc = emp.aadhaar_number;
  }
  if (!Object.keys(emp).length) return;
  await p.employee.update({ where: { id: cpId }, data: emp });
  await p.cpApplication.updateMany({ where: { employee_id: cpId }, data: form });
}

const peopleWhoCheck = async (companyId: number): Promise<number[]> => {
  const rows = await p.employee.findMany({
    where: {
      company_id: companyId,
      status: 'ACTIVE',
      roles: { some: { role: { name: { in: [Roles.HR_MANAGER, Roles.MD] } } } },
    },
    select: { id: true },
  });
  return rows.map((r: any) => r.id);
};

cpProfileRouter.put(
  '/me/profile',
  requireCp,
  requireOwner,
  handle(async (req, res) => {
    // Only the partner themselves changes their details, never our staff signed in to their area.
    if (req.cp!.staff) {
      return res.status(403).json({ error: 'Only the partner can change these details.' });
    }
    const body = ProfileSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: body.error.issues[0]?.message });
    const d = body.data;
    const cpId = req.cp!.id;
    const { e, form } = await loadProfile(cpId);

    // Sensitive values: new where blank is saved at once; a change to a filled value waits for confirmation.
    const now: Record<string, string> = {};
    const later: Record<string, string> = {};
    const bankKeys = ['bank_name', 'bank_branch', 'ifsc', 'bank_account'] as const;
    const current: Record<string, string | null> = {
      bank_name: dec(e.bank_name),
      bank_branch: dec(e.bank_branch),
      ifsc: dec(e.bank_ifsc),
      bank_account: dec(e.bank_account_number),
      pan: dec(e.pan_number),
      aadhaar: dec(e.aadhaar_number),
    };
    const bankSent = bankKeys.filter((k) => d[k] !== undefined && d[k] !== current[k]);
    if (bankSent.length) {
      if (!current.bank_account) {
        if (!d.bank_account || !(d.ifsc ?? current.ifsc) || !(d.bank_name ?? current.bank_name)) {
          return res
            .status(400)
            .json({ error: 'Enter the bank name, account number and IFSC together.' });
        }
        for (const k of bankSent) now[k] = d[k]!;
      } else {
        for (const k of bankSent) later[k] = d[k]!;
      }
    }
    for (const k of ['pan', 'aadhaar'] as const) {
      if (d[k] === undefined || d[k] === current[k]) continue;
      (current[k] ? later : now)[k] = d[k]!;
    }
    if (Object.keys(later).length) {
      if (!d.current_password || !(await bcrypt.compare(d.current_password, e.password_hash))) {
        return res.status(400).json({
          error: 'To change bank, PAN or Aadhaar details already saved, enter your password.',
          needs_password: true,
        });
      }
    }

    // Contact details: free to change.
    const emp: Record<string, unknown> = {};
    const formData: Record<string, unknown> = {};
    if (d.email && d.email !== e.email) {
      const taken = await p.employee.findFirst({
        where: { company_id: e.company_id, email: d.email, id: { not: cpId } },
        select: { id: true },
      });
      if (taken) return res.status(409).json({ error: 'That email is already in use.' });
      emp.email = d.email;
      formData.email = d.email;
    }
    if (d.whatsapp) {
      emp.whatsapp_number = d.whatsapp.slice(-10);
      formData.whatsapp = d.whatsapp.slice(-10);
    }
    if (d.address) {
      emp.current_address = d.address;
      formData.address = d.address;
    }
    if (d.occupation !== undefined) formData.occupation = d.occupation;
    if (d.photo && d.photo_thumb) {
      const jpeg = /^[A-Za-z0-9+/]+={0,2}$/;
      if (!jpeg.test(d.photo) || !jpeg.test(d.photo_thumb)) {
        return res.status(400).json({ error: 'That photo could not be read. Try another one.' });
      }
      formData.photo_data = d.photo;
      formData.photo_thumb = d.photo_thumb;
    }
    if (Object.keys(emp).length) await p.employee.update({ where: { id: cpId }, data: emp });
    if (form && Object.keys(formData).length) {
      await p.cpApplication.update({ where: { id: form.id }, data: formData });
    }

    await applySensitive(cpId, now);

    const labels: Record<string, string> = {
      bank_name: 'Bank name',
      bank_branch: 'Bank branch',
      ifsc: 'IFSC',
      bank_account: 'Account number',
      pan: 'PAN',
      aadhaar: 'Aadhaar',
    };
    const describe = (v: Record<string, string>) =>
      Object.keys(v)
        .map((k) =>
          ['bank_account', 'pan', 'aadhaar'].includes(k)
            ? `${labels[k]} ${tail(v[k])}`
            : `${labels[k]} ${v[k]}`,
        )
        .join(', ');

    if (Object.keys(later).length) {
      const encrypted = Object.fromEntries(
        Object.entries(later).map(([k, v]) => [k, encryptData(v)]),
      );
      await p.cpDetailsChange.updateMany({
        where: { cp_id: cpId, status: 'PENDING' },
        data: { status: 'REPLACED' },
      });
      await p.cpDetailsChange.create({
        data: {
          cp_id: cpId,
          company_id: e.company_id,
          fields: encrypted,
          summary: describe(later).slice(0, 500),
          status: 'PENDING',
        },
      });
    }

    if (Object.keys(now).length || Object.keys(later).length) {
      await p.auditEvent
        .create({
          data: {
            actor_id: cpId,
            action: Object.keys(later).length ? 'CP_DETAILS_CHANGE_ASKED' : 'CP_DETAILS_FILLED',
            entity_type: 'EMPLOYEE',
            entity_id: cpId,
            reason: describe({ ...now, ...later }).slice(0, 500),
          },
        })
        .catch(() => undefined);
      const who = `${e.full_name} (${e.employee_code})`;
      await notifyEmployee(await peopleWhoCheck(e.company_id), {
        type: 'CP_DETAILS_CHANGE',
        title: Object.keys(later).length
          ? 'A partner wants to change bank or ID details'
          : 'A partner filled in bank or ID details',
        message: Object.keys(later).length
          ? `${who} asked to change: ${describe(later)}. Please confirm it.`
          : `${who} added: ${describe(now)}.`,
        link: '/channel-partners',
      }).catch((err) => logger.warn({ err }, '[CP] could not notify about changed details'));
    }

    return res.status(200).json({
      ...(await profileView(cpId)),
      saved: true,
      can_edit: true,
      waiting_for_confirmation: Object.keys(later).length > 0,
    });
  }),
);

// ── our side: HR / MD / Admin confirm changes ─────────────────

export const cpChangesRouter = Router();
const checkers = requireRole([Roles.HR_MANAGER, Roles.MD, Roles.ADMIN]);

cpChangesRouter.get(
  '/',
  authenticateToken,
  checkers,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const companyIds = await getAccessibleCompanyIds(req.user!);
      const rows = await p.cpDetailsChange.findMany({
        where: { company_id: { in: companyIds }, status: 'PENDING' },
        orderBy: { id: 'asc' },
        take: 100,
      });
      const people = await p.employee.findMany({
        where: { id: { in: rows.map((r: any) => r.cp_id) } },
        select: { id: true, full_name: true, employee_code: true },
      });
      const byId = new Map<number, any>(people.map((x: any) => [x.id, x]));
      return res.status(200).json({
        changes: rows.map((r: any) => ({
          id: r.id,
          partner_id: r.cp_id,
          partner_name: byId.get(r.cp_id)?.full_name ?? null,
          partner_code: byId.get(r.cp_id)?.employee_code ?? null,
          summary: r.summary,
          sent_at: r.created_at,
        })),
      });
    } catch (e) {
      next(e);
    }
  },
);

cpChangesRouter.post(
  '/:id/decide',
  authenticateToken,
  checkers,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const id = Number(req.params.id);
      const body = z
        .object({ approve: z.boolean(), note: z.string().trim().max(300).optional() })
        .safeParse(req.body);
      if (!Number.isInteger(id) || id <= 0 || !body.success)
        return res.status(400).json({ error: 'Choose confirm or refuse.' });
      const companyIds = await getAccessibleCompanyIds(req.user!);
      const row = await p.cpDetailsChange.findFirst({
        where: { id, company_id: { in: companyIds } },
      });
      if (!row) return res.status(404).json({ error: 'Not found' });
      if (!body.data.approve && !body.data.note)
        return res.status(400).json({ error: 'Say why you are refusing it.' });
      // Claim it first, so two people pressing at once cannot both act.
      const claimed = await p.cpDetailsChange.updateMany({
        where: { id, status: 'PENDING' },
        data: {
          status: body.data.approve ? 'APPROVED' : 'REFUSED',
          decided_by: req.user!.employeeId,
          decided_at: new Date(),
          note: body.data.note ?? null,
        },
      });
      if (!claimed.count)
        return res.status(409).json({ error: 'Someone has already dealt with this.' });
      if (body.data.approve) {
        const fields = (
          typeof row.fields === 'string' ? JSON.parse(row.fields) : row.fields
        ) as Record<string, string>;
        await applySensitive(
          row.cp_id,
          Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, dec(v) ?? undefined])),
        );
      }
      await p.auditEvent
        .create({
          data: {
            actor_id: req.user!.employeeId,
            action: body.data.approve ? 'CP_DETAILS_CONFIRMED' : 'CP_DETAILS_REFUSED',
            entity_type: 'EMPLOYEE',
            entity_id: row.cp_id,
            reason: `${row.summary}${body.data.note ? ` — ${body.data.note}` : ''}`.slice(0, 500),
          },
        })
        .catch(() => undefined);
      await notifyEmployee(row.cp_id, {
        type: 'CP_DETAILS_ANSWER',
        title: body.data.approve ? 'Your new details are saved' : 'Your change was not accepted',
        message: body.data.approve ? row.summary : `${row.summary}. Reason: ${body.data.note}`,
        link: '/partner',
      }).catch(() => undefined);
      return res.status(200).json({ ok: true });
    } catch (e) {
      next(e);
    }
  },
);
