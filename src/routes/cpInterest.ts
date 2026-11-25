import { Router, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';
import { Roles } from '../shared';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { cpInterestRateLimiter } from '../middleware/rateLimiter';
import { normalizeCpPhone } from '../services/cpLeadImport';
import { getAccessibleCompanyIds } from '../authz/dataScope';
import { decryptData, encryptData } from '../utils/crypto';
import bcrypt from 'bcryptjs';
import { requireAuthz } from '../middleware/authz';
import { Permissions } from '../shared';
import { generateTemporaryPassword } from '../utils/tempPassword';
import {
  employeeContactConflictMessage,
  findEmployeeContactConflict,
  normaliseEmployeeEmail,
  normaliseEmployeePhone,
} from '../services/employeeContact.service';

/**
 * The channel partner registration form (2026-11-23): the paper form, online.
 *
 * POST / is deliberately UNAUTHENTICATED (partners reach it through a link we share, with no account),
 * so it is rate limited, takes a fixed set of fields only, and answers the same whether or not the
 * phone number was sent before (a repeat updates the earlier entry and keeps its partner number).
 * It only COLLECTS details: no account, lead or notification is created from it. HR (and MD, Admin,
 * Marketing Director) read the entries in the HR hub.
 *
 * Aadhaar, PAN and the bank account are stored encrypted. The list only ever carries them masked; the
 * full values come from GET /:id/sensitive, which is logged.
 */
/** Bump when the terms in the web form change, so each entry shows which wording was accepted. */
const TERMS_VERSION = '2026-11-23';

/** A photo from the form: a small JPEG as base64 (the phone shrinks it first). Checked by its real bytes. */
const MAX_PHOTO_BYTES = 150 * 1024;
const MAX_THUMB_BYTES = 15 * 1024;
const jpegBase64 = (limit: number) =>
  z
    .string()
    .max(Math.ceil((limit * 4) / 3) + 8, 'The photo is too large')
    .refine((v) => /^[A-Za-z0-9+/]+={0,2}$/.test(v), 'The photo could not be read')
    .refine((v) => {
      const b = Buffer.from(v, 'base64');
      return b.length > 0 && b.length <= limit && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    }, 'Please use a JPG or PNG photo');

type Kind = 'CP' | 'ASSOCIATE';
const p = prisma as any;

/** An empty form field means "not given". */
const blank = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const optional = <T extends z.ZodTypeAny>(t: T) => z.preprocess(blank, t.optional());

const FormSchema = z.object({
  full_name: z.string().trim().min(2, 'Enter your full name').max(120),
  father_spouse_name: z.string().trim().min(2, "Enter your father's or spouse's name").max(120),
  age: z.coerce
    .number({ invalid_type_error: 'Enter your age' })
    .int()
    .min(18, 'You must be 18 or older')
    .max(90, 'Enter a valid age'),
  occupation: z.string().trim().min(2, 'Enter your occupation').max(80),
  address: z.string().trim().min(8, 'Enter your full address').max(500),
  phone: z.string().trim().min(8, 'Enter your mobile number').max(20),
  whatsapp: optional(z.string().trim().max(20)),
  email: z.string().trim().toLowerCase().email('Enter a valid email address').max(120),
  projects_handled: z
    .string()
    .trim()
    .min(3, 'Tell us about your projects')
    .max(2000, 'Please keep this under 2000 characters'),
  // Bank and ID details are optional here; HR can collect them later.
  bank_name: optional(z.string().trim().max(80)),
  bank_branch: optional(z.string().trim().max(80)),
  bank_account: optional(
    z
      .string()
      .transform((v) => v.replace(/\s|-/g, ''))
      .pipe(z.string().regex(/^\d{6,20}$/, 'Bank account number should be 6 to 20 digits')),
  ),
  ifsc: optional(
    z
      .string()
      .transform((v) => v.replace(/\s/g, '').toUpperCase())
      .pipe(z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'IFSC looks wrong. Example: SBIN0001234')),
  ),
  pan: optional(
    z
      .string()
      .transform((v) => v.replace(/\s/g, '').toUpperCase())
      .pipe(z.string().regex(/^[A-Z]{5}\d{4}[A-Z]$/, 'PAN looks wrong. Example: ABCDE1234F')),
  ),
  aadhaar: optional(
    z
      .string()
      .transform((v) => v.replace(/[\s-]/g, ''))
      .pipe(z.string().regex(/^[2-9]\d{11}$/, 'Aadhaar should be 12 digits')),
  ),
  photo: optional(jpegBase64(MAX_PHOTO_BYTES)),
  photo_thumb: optional(jpegBase64(MAX_THUMB_BYTES)),
  place: z.string().trim().min(2, 'Enter your place').max(80),
  agreed: z.literal(true, {
    errorMap: () => ({ message: 'Please accept the terms and conditions to continue' }),
  }),
  // A hidden field real people never fill: bots do.
  website: z.string().optional(),
});

/**
 * One registration form and its list, for either kind of person (2026-11-23):
 * 'CP'        channel partners (companies with a partner area), read by HR; HR gives them partner access.
 * 'ASSOCIATE' associates (individual agents), read by HR and the Channel Partner Manager, who onboards them
 *             into the Associates list.
 */
function registrationRouter(kind: Kind) {
  const router = Router();
  const PREFIX = kind === 'CP' ? 'RRH-CP-' : 'RRH-AS-';

  /** The company a form entry belongs to: set in the environment, else the Radha Real Home company. */
  async function formCompanyId(): Promise<number | null> {
    const code = process.env.CP_FORM_COMPANY_CODE;
    const company = code
      ? await p.company.findFirst({ where: { code }, select: { id: true } })
      : ((await p.company.findFirst({
          where: { OR: [{ code: { contains: 'RRH' } }, { code: { contains: 'RADHA' } }] },
          orderBy: { id: 'asc' },
          select: { id: true },
        })) ?? (await p.company.findFirst({ orderBy: { id: 'asc' }, select: { id: true } })));
    return company?.id ?? null;
  }

  /** The next partner number for a company: RRH-CP-0001, RRH-CP-0002, ... */
  async function nextPartnerNo(company_id: number | null): Promise<string> {
    const rows = await p.cpApplication.findMany({
      where: { company_id, kind, partner_no: { startsWith: PREFIX } },
      select: { partner_no: true },
    });
    const top = rows.reduce((m: number, r: { partner_no: string }) => {
      const n = Number(r.partner_no.slice(PREFIX.length));
      return Number.isInteger(n) && n > m ? n : m;
    }, 0);
    return `${PREFIX}${String(top + 1).padStart(4, '0')}`;
  }

  const maskTail = (v: string | null, keep: number) =>
    v ? `${'X'.repeat(Math.max(0, v.length - keep))}${v.slice(-keep)}` : null;

  router.post('/', cpInterestRateLimiter, async (req, res: Response) => {
    try {
      const body = FormSchema.safeParse(req.body || {});
      if (!body.success) {
        return res
          .status(400)
          .json({ error: body.error.issues[0]?.message || 'Check the details.' });
      }
      const d = body.data;
      // A bot filled the hidden field: pretend it worked and store nothing.
      if (d.website) return res.status(201).json({ ok: true, partner_no: `${PREFIX}0000` });

      const phone = normalizeCpPhone(d.phone);
      if (!phone) return res.status(400).json({ error: 'Enter a valid 10-digit mobile number.' });
      const whatsapp = d.whatsapp ? normalizeCpPhone(d.whatsapp) : phone;
      if (!whatsapp)
        return res.status(400).json({ error: 'Enter a valid 10-digit WhatsApp number.' });

      const company_id = await formCompanyId();
      const data = {
        full_name: d.full_name,
        father_spouse_name: d.father_spouse_name,
        age: d.age,
        occupation: d.occupation,
        address: d.address,
        email: d.email,
        whatsapp,
        projects_handled: d.projects_handled,
        bank_name: d.bank_name ?? null,
        bank_branch: d.bank_branch ?? null,
        ifsc: d.ifsc ?? null,
        bank_account_enc: d.bank_account ? encryptData(d.bank_account) : null,
        pan_enc: d.pan ? encryptData(d.pan) : null,
        aadhaar_enc: d.aadhaar ? encryptData(d.aadhaar) : null,
        place: d.place,
        // A photo is kept only when the new entry has one: sending again without it keeps the old one.
        ...(d.photo && d.photo_thumb ? { photo_data: d.photo, photo_thumb: d.photo_thumb } : {}),
        agreed_terms_at: new Date(),
        terms_version: TERMS_VERSION,
      };

      const existing = await p.cpApplication.findFirst({ where: { company_id, phone, kind } });
      if (existing) {
        const row = await p.cpApplication.update({
          where: { id: existing.id },
          data: {
            ...data,
            // An earlier entry (before the full form) has no number yet: it gets one now.
            ...(existing.partner_no ? {} : { partner_no: await nextPartnerNo(company_id) }),
            submissions: existing.submissions + 1,
            status: 'NEW',
          },
        });
        return res.status(201).json({ ok: true, partner_no: row.partner_no });
      }
      // Two people sending at the same moment could be given the same number: the unique key refuses
      // the second, which then takes the next one.
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const row = await p.cpApplication.create({
            data: { company_id, phone, kind, ...data, partner_no: await nextPartnerNo(company_id) },
          });
          return res.status(201).json({ ok: true, partner_no: row.partner_no });
        } catch (e: any) {
          if (e?.code !== 'P2002') throw e;
          // Same phone sent twice at once: update instead.
          const again = await p.cpApplication.findFirst({ where: { company_id, phone, kind } });
          if (again) {
            return res.status(201).json({ ok: true, partner_no: again.partner_no });
          }
        }
      }
      throw new Error('Could not allocate a partner number');
    } catch (e) {
      logger.error({ err: e }, 'Channel partner registration form error');
      return res.status(500).json({ error: 'Could not save your details. Please try again.' });
    }
  });

  // ---- HR side ---------------------------------------------------------------------------------

  const hrRoles: string[] = [Roles.MD, Roles.HR_MANAGER, Roles.ADMIN, Roles.MARKETING_DIRECTOR];
  // Channel partners are HR's business. Associates are also the Channel Partner Manager's.
  const readers: string[] =
    kind === 'CP' ? hrRoles : [...hrRoles, Roles.CHANNEL_PARTNER_MANAGER, Roles.TECHNICAL_MANAGER];
  // Bank, PAN and Aadhaar in full: only HR, the MD and Admin (a Channel Partner Manager sees them masked).
  const onlyHrStrict = (req: AuthenticatedRequest, res: Response, next: () => void) =>
    (req.user?.roles || []).some((r) => hrRoles.includes(r))
      ? next()
      : res.status(403).json({ error: 'Only HR, the MD or Admin can open these.' });
  const onlyHr = (req: AuthenticatedRequest, res: Response, next: () => void) =>
    (req.user?.roles || []).some((r) => readers.includes(r))
      ? next()
      : res.status(403).json({ error: 'Only HR, the MD or Admin can see these.' });

  /** What the list shows: everything except the secrets, which are masked. */
  function present(row: any) {
    const { bank_account_enc, pan_enc, aadhaar_enc, photo_data, photo_thumb, ...rest } = row;
    const account = decryptData(bank_account_enc);
    const pan = decryptData(pan_enc);
    const aadhaar = decryptData(aadhaar_enc);
    return {
      ...rest,
      bank_account_masked: maskTail(account, 4),
      pan_masked: maskTail(pan, 4),
      aadhaar_masked: maskTail(aadhaar, 4),
      has_bank: !!(account && rest.ifsc && rest.bank_name),
      has_pan: !!pan,
      has_aadhaar: !!aadhaar,
      has_photo: !!photo_data,
      has_access: !!rest.employee_id,
      has_onboarded: !!rest.associate_id,
      photo_thumb: photo_thumb ? `data:image/jpeg;base64,${photo_thumb}` : null,
    };
  }

  router.get('/', authenticateToken, onlyHr, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const companyIds = await getAccessibleCompanyIds(req.user!);
      const status =
        req.query.status === 'REVIEWED' || req.query.status === 'NEW'
          ? req.query.status
          : undefined;
      const rows = await p.cpApplication.findMany({
        where: { company_id: { in: companyIds }, kind, ...(status ? { status } : {}) },
        orderBy: [{ status: 'asc' }, { updated_at: 'desc' }],
        take: 500,
      });
      const counts = await p.cpApplication.groupBy({
        by: ['status'],
        where: { company_id: { in: companyIds }, kind },
        _count: { _all: true },
      });
      const n = (s: string) => counts.find((c: any) => c.status === s)?._count._all ?? 0;
      return res.status(200).json({
        applications: rows.map(present),
        counts: { new: n('NEW'), reviewed: n('REVIEWED'), total: n('NEW') + n('REVIEWED') },
      });
    } catch (e) {
      logger.error({ err: e }, 'Channel partner registration list error');
      return res.status(500).json({ error: 'Could not load the partner details.' });
    }
  });

  if (kind === 'CP') {
    // Give partner access: makes the partner-area account for this entry. The sign-in ID is the partner number
    // (RRH-CP-0001) and the password is made here and shown ONCE to the person who pressed the button.
    router.post(
      '/:id/give-access',
      authenticateToken,
      onlyHr,
      requireAuthz(Permissions.EMPLOYEES_CREATE),
      async (req: AuthenticatedRequest, res: Response) => {
        try {
          const id = Number(req.params.id);
          if (!Number.isInteger(id) || id <= 0)
            return res.status(400).json({ error: 'Check the details.' });
          const companyIds = await getAccessibleCompanyIds(req.user!);
          const row = await p.cpApplication.findFirst({
            where: { id, company_id: { in: companyIds }, kind },
          });
          if (!row) return res.status(404).json({ error: 'Not found' });
          if (row.employee_id) {
            return res.status(409).json({
              error:
                'Partner access was already given. Reset the password from the employee page if they forgot it.',
            });
          }
          const companyId: number = row.company_id ?? req.user!.companyId;
          const partnerNo: string = row.partner_no || (await nextPartnerNo(row.company_id));

          const phone = normaliseEmployeePhone(row.phone);
          const email = normaliseEmployeeEmail(row.email);
          const conflict = await findEmployeeContactConflict(prisma, { companyId, phone, email });
          if (conflict) {
            return res.status(409).json({
              error: `${employeeContactConflictMessage(conflict)} If this is one of our own people who only needs to see or demo the partner area, do not make a new account: open Channel partners, pick a partner and use "Add one of our employees to this team" with Full access.`,
              conflict: { field: conflict.field, employee_code: conflict.employee.employee_code },
            });
          }
          if (
            await p.employee.findFirst({
              where: { employee_code: partnerNo },
              select: { id: true },
            })
          ) {
            return res
              .status(409)
              .json({ error: `The sign-in ID ${partnerNo} is already in use.` });
          }
          const role = await p.role.findUnique({ where: { name: Roles.CHANNEL_PARTNER_EXTERNAL } });
          if (!role) return res.status(400).json({ error: 'The channel partner role is missing.' });
          // The branch of the person giving access, else the company's first branch.
          const branch =
            (req.user!.branchId
              ? await p.branch.findFirst({
                  where: { id: req.user!.branchId, company_id: companyId },
                })
              : null) ??
            (await p.branch.findFirst({
              where: { company_id: companyId },
              orderBy: { id: 'asc' },
            }));
          if (!branch) return res.status(400).json({ error: 'This company has no branch yet.' });

          const password = generateTemporaryPassword();
          const created = await p.$transaction(async (tx: any) => {
            const emp = await tx.employee.create({
              data: {
                employee_code: partnerNo,
                full_name: row.full_name,
                phone,
                whatsapp_number: row.whatsapp || phone,
                email,
                current_address: row.address,
                permanent_address: row.address,
                // The bank and ID values are already encrypted the same way as employee records.
                pan_number: row.pan_enc,
                aadhaar_number: row.aadhaar_enc,
                bank_account_number: row.bank_account_enc,
                bank_name: encryptData(row.bank_name),
                bank_ifsc: encryptData(row.ifsc),
                bank_branch: encryptData(row.bank_branch),
                job_title: row.designation || 'Channel partner',
                department: 'Channel partners',
                employment_type: 'CONTRACT',
                report_required: false,
                attendance_required: false,
                salary_ctc: 0,
                date_of_joining: new Date(),
                company_id: companyId,
                branch_id: branch.id,
                password_hash: await bcrypt.hash(password, 12),
                status: 'ACTIVE',
                first_login_done: false,
                roles: { create: { role_id: role.id } },
                company_access: { create: [{ company_id: companyId }] },
              },
            });
            await tx.cpApplication.update({
              where: { id },
              data: {
                partner_no: partnerNo,
                employee_id: emp.id,
                access_given_at: new Date(),
                access_given_by: req.user!.employeeId,
                status: 'REVIEWED',
              },
            });
            await tx.auditEvent.create({
              data: {
                actor_id: req.user!.employeeId,
                action: 'CP_ACCESS_GIVEN',
                entity_type: 'EMPLOYEE',
                entity_id: emp.id,
                reason: `Partner area account made for ${row.full_name} (${partnerNo})`,
              },
            });
            return emp;
          });
          return res.status(201).json({
            employee_id: created.id,
            sign_in_id: partnerNo,
            password,
            name: row.full_name,
            phone: row.phone,
            whatsapp: row.whatsapp || row.phone,
          });
        } catch (e) {
          logger.error({ err: e }, 'Channel partner give access error');
          return res.status(500).json({ error: 'Could not give access. Please try again.' });
        }
      },
    );
  }

  if (kind === 'ASSOCIATE') {
    // Onboard: adds this person to the Associates list as someone who has joined, with the associate number
    // (RRH-AS-0001) as their ID. A Channel Partner Manager onboards for themselves; HR, the MD and Admin choose
    // who looks after the new associate.
    router.post(
      '/:id/onboard',
      authenticateToken,
      onlyHr,
      async (req: AuthenticatedRequest, res: Response) => {
        try {
          const id = Number(req.params.id);
          if (!Number.isInteger(id) || id <= 0)
            return res.status(400).json({ error: 'Check the details.' });
          const companyIds = await getAccessibleCompanyIds(req.user!);
          const row = await p.cpApplication.findFirst({
            where: { id, company_id: { in: companyIds }, kind },
          });
          if (!row) return res.status(404).json({ error: 'Not found' });
          if (row.associate_id) {
            return res
              .status(409)
              .json({ error: 'This person is already in the Associates list.' });
          }
          const companyId: number = row.company_id ?? req.user!.companyId;
          const roles = req.user!.roles || [];
          const onlyCpm =
            roles.includes(Roles.CHANNEL_PARTNER_MANAGER) &&
            !roles.some((r) => hrRoles.includes(r) || r === Roles.TECHNICAL_MANAGER);
          const wanted = Number(req.body?.owner_cpm_id) || null;
          const owner: number | null = onlyCpm ? req.user!.employeeId : wanted;
          if (owner) {
            const ok = await p.employee.findFirst({
              where: {
                id: owner,
                company_id: companyId,
                status: 'ACTIVE',
                roles: { some: { role: { name: Roles.CHANNEL_PARTNER_MANAGER } } },
              },
              select: { id: true },
            });
            if (!ok) {
              return res.status(400).json({ error: 'Choose an active Channel Partner Manager.' });
            }
          }

          const code: string = row.partner_no || (await nextPartnerNo(row.company_id));
          const existing = await p.associate.findFirst({
            where: { company_id: companyId, phone: row.phone },
          });
          const clash = await p.associate.findFirst({
            where: {
              company_id: companyId,
              associate_code: code,
              ...(existing ? { id: { not: existing.id } } : {}),
            },
            select: { id: true },
          });
          if (clash) {
            return res.status(409).json({ error: `The associate ID ${code} is already in use.` });
          }
          const notes = [
            row.occupation ? `Occupation: ${row.occupation}` : '',
            row.address ? `Address: ${row.address}` : '',
            row.projects_handled ? `Projects: ${row.projects_handled}` : '',
            'Joined through the registration form.',
          ]
            .filter(Boolean)
            .join('\n')
            .slice(0, 2000);
          const now = new Date();
          const BEFORE_JOINING = ['INVITED', 'CONTACTED', 'AGREED', 'DOCUMENTS'];

          const result = await p.$transaction(async (tx: any) => {
            const associate = existing
              ? await tx.associate.update({
                  where: { id: existing.id },
                  data: {
                    ...(existing.associate_code ? {} : { associate_code: code }),
                    ...(existing.email ? {} : { email: row.email }),
                    ...(existing.owner_cpm_id || !owner ? {} : { owner_cpm_id: owner }),
                    ...(existing.enrolled_at ? {} : { enrolled_at: now }),
                    ...(BEFORE_JOINING.includes(existing.pipeline)
                      ? { pipeline: 'ENROLLED', pipeline_changed_at: now }
                      : {}),
                  },
                })
              : await tx.associate.create({
                  data: {
                    company_id: companyId,
                    full_name: row.full_name,
                    phone: row.phone,
                    associate_code: code,
                    email: row.email,
                    pipeline: 'ENROLLED',
                    enrolled_at: now,
                    owner_cpm_id: owner,
                    notes,
                    source: 'FORM',
                    created_by_id: req.user!.employeeId,
                  },
                });
            await tx.cpApplication.update({
              where: { id },
              data: {
                partner_no: code,
                associate_id: associate.id,
                access_given_at: now,
                access_given_by: req.user!.employeeId,
                status: 'REVIEWED',
              },
            });
            await tx.auditEvent.create({
              data: {
                actor_id: req.user!.employeeId,
                action: 'ASSOCIATE_ONBOARDED',
                entity_type: 'ASSOCIATE',
                entity_id: associate.id,
                reason: `${row.full_name} (${code}) added to the Associates list`,
              },
            });
            return associate;
          });
          return res.status(201).json({
            associate_id: result.id,
            associate_code: code,
            owner_cpm_id: result.owner_cpm_id,
            was_in_list: !!existing,
            name: row.full_name,
          });
        } catch (e) {
          logger.error({ err: e }, 'Associate onboarding error');
          return res.status(500).json({ error: 'Could not add them. Please try again.' });
        }
      },
    );
  }

  // The full-size photo of one entry, as an image.
  router.get(
    '/:id/photo',
    authenticateToken,
    onlyHr,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0)
          return res.status(400).json({ error: 'Check the details.' });
        const companyIds = await getAccessibleCompanyIds(req.user!);
        const row = await p.cpApplication.findFirst({
          where: { id, company_id: { in: companyIds }, kind },
          select: { photo_data: true },
        });
        if (!row?.photo_data) return res.status(404).json({ error: 'No photo' });
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'private, max-age=300');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        return res.status(200).send(Buffer.from(row.photo_data, 'base64'));
      } catch (e) {
        logger.error({ err: e }, 'Channel partner registration photo error');
        return res.status(500).json({ error: 'Could not load the photo.' });
      }
    },
  );

  // The full bank account, PAN and Aadhaar of one entry. Every read is written to the audit log.
  router.get(
    '/:id/sensitive',
    authenticateToken,
    onlyHrStrict,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0)
          return res.status(400).json({ error: 'Check the details.' });
        const companyIds = await getAccessibleCompanyIds(req.user!);
        const row = await p.cpApplication.findFirst({
          where: { id, company_id: { in: companyIds }, kind },
        });
        if (!row) return res.status(404).json({ error: 'Not found' });
        await p.auditEvent.create({
          data: {
            actor_id: req.user!.employeeId,
            action: 'CP_APPLICATION_SENSITIVE_VIEWED',
            entity_type: 'CP_APPLICATION',
            entity_id: id,
            reason: `Viewed bank, PAN and Aadhaar of ${row.partner_no || `entry ${id}`}`,
          },
        });
        return res.status(200).json({
          bank_account: decryptData(row.bank_account_enc),
          pan: decryptData(row.pan_enc),
          aadhaar: decryptData(row.aadhaar_enc),
        });
      } catch (e) {
        logger.error({ err: e }, 'Channel partner registration sensitive read error');
        return res.status(500).json({ error: 'Could not load.' });
      }
    },
  );

  const EditSchema = z.object({
    status: z.enum(['NEW', 'REVIEWED']).optional(),
    hr_note: z.string().trim().max(500).optional().nullable(),
    // The paper form's "company" part: filled by HR.
    designation: z.string().trim().max(80).optional().nullable(),
    commission: z.string().trim().max(80).optional().nullable(),
    travel_allowance: z.string().trim().max(80).optional().nullable(),
    superior: z.string().trim().max(120).optional().nullable(),
  });
  router.patch(
    '/:id',
    authenticateToken,
    onlyHr,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const id = Number(req.params.id);
        const body = EditSchema.safeParse(req.body || {});
        if (!Number.isInteger(id) || id <= 0 || !body.success) {
          return res.status(400).json({ error: 'Check the details.' });
        }
        const companyIds = await getAccessibleCompanyIds(req.user!);
        const row = await p.cpApplication.findFirst({
          where: { id, company_id: { in: companyIds }, kind },
        });
        if (!row) return res.status(404).json({ error: 'Not found' });
        const d = body.data;
        const clean = (v: string | null | undefined) => (v === undefined ? undefined : v || null);
        const saved = await p.cpApplication.update({
          where: { id },
          data: {
            ...(d.status ? { status: d.status } : {}),
            ...(d.hr_note !== undefined ? { hr_note: clean(d.hr_note) } : {}),
            ...(d.designation !== undefined ? { designation: clean(d.designation) } : {}),
            ...(d.commission !== undefined ? { commission: clean(d.commission) } : {}),
            ...(d.travel_allowance !== undefined
              ? { travel_allowance: clean(d.travel_allowance) }
              : {}),
            ...(d.superior !== undefined ? { superior: clean(d.superior) } : {}),
          },
        });
        return res.status(200).json({ application: present(saved) });
      } catch (e) {
        logger.error({ err: e }, 'Channel partner registration edit error');
        return res.status(500).json({ error: 'Could not save.' });
      }
    },
  );

  return router;
}

export default registrationRouter('CP');
export const associateRegistrationRouter = registrationRouter('ASSOCIATE');
