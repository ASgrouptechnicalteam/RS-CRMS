import { prisma } from '../lib/prisma';
import { TokenPayload } from '../utils/jwt';
import { AppError } from './lead/errors';
import { Roles } from '../shared';
import { seesAllAssociates, tenDigits, wouldLoop } from './associate.service';

// Import of associates from the old portal's export or a spreadsheet saved as
// CSV. Preview and import run the same plan, so what the preview shows is what
// gets written. Rows repeat by phone: the first row wins. Someone already in
// the CRM is never overwritten; only their empty fields are filled. Columns
// other than the ones below (PAN, Aadhaar, bank details and anything else)
// are never read or stored.

const p = prisma;
export const MAX_IMPORT_ROWS = 2000;

const FIELDS: Record<string, string[]> = {
  associate_code: [
    'associatecode',
    'code',
    'associateid',
    'rscode',
    'useridentifier',
    'userid',
    'id',
  ],
  portal_user_id: ['portaluserid', 'uuid'],
  full_name: ['name', 'fullname', 'associatename', 'username'],
  phone: [
    'phone',
    'mobile',
    'mobileno',
    'mobilenumber',
    'phonenumber',
    'phoneno',
    'contact',
    'contactnumber',
  ],
  email: ['email', 'emailid', 'emailaddress', 'mail'],
  designation: ['designation', 'position', 'rank'],
  upline: [
    'upline',
    'uplinecode',
    'uplinephone',
    'referralid',
    'referraluserid',
    'referredby',
    'broughtinby',
    'parent',
    'parentid',
    'parentcode',
    'sponsor',
  ],
  notes: ['notes', 'note', 'remarks', 'remark'],
};
const MAX_LEN: Record<string, number> = {
  associate_code: 40,
  portal_user_id: 64,
  full_name: 120,
  email: 254,
  designation: 80,
  upline: 64,
  notes: 1000,
};
const headerKey = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, '');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Plain CSV: commas, double quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

type Item = {
  row: number;
  full_name: string;
  phone: string;
  associate_code: string | null;
  portal_user_id: string | null;
  email: string | null;
  designation: string | null;
  upline: string | null;
  notes: string | null;
};

export async function planImport(user: TokenPayload, csv: string) {
  const table = parseCsv(csv || '');
  if (table.length < 2) throw new AppError(400, 'The file has no rows under the header.');
  if (table.length - 1 > MAX_IMPORT_ROWS) {
    throw new AppError(
      400,
      `Up to ${MAX_IMPORT_ROWS} associates per file. Split the file and import each part.`,
    );
  }
  const header = table[0].map(headerKey);
  const col: Record<string, number> = {};
  for (const [field, names] of Object.entries(FIELDS)) {
    const i = header.findIndex((h) => names.includes(h));
    if (i >= 0) col[field] = i;
  }
  if (col.full_name === undefined || col.phone === undefined) {
    throw new AppError(
      400,
      'Could not find the name and phone columns. Name the columns "Name" and "Phone".',
    );
  }
  const used = new Set(Object.values(col));
  const ignored_columns = table[0]
    .filter((_, i) => !used.has(i))
    .map((h) => h.trim())
    .filter(Boolean);

  const invalid: { row: number; reason: string }[] = [];
  const repeats_in_file: { row: number; phone: string; first_row: number }[] = [];
  const code_conflicts: { row: number; code: string; reason: string }[] = [];
  const items: Item[] = [];
  const shown = new Map<number, { name: string; phone: string }>();
  const seenPhone = new Map<string, number>();
  const seenCode = new Map<string, number>();

  table.slice(1).forEach((cells, idx) => {
    const row = idx + 2; // spreadsheet line, header is line 1
    const get = (f: string) =>
      col[f] === undefined
        ? ''
        : String(cells[col[f]] ?? '')
            .trim()
            .slice(0, MAX_LEN[f] ?? 200);
    const phone = tenDigits(get('phone'));
    const full_name = get('full_name');
    shown.set(row, { name: full_name, phone: get('phone') });
    if (!/^\d{10}$/.test(phone))
      return invalid.push({
        row,
        reason: `Phone "${get('phone')}" is not a 10-digit mobile number`,
      });
    if (full_name.length < 2) return invalid.push({ row, reason: 'Name is missing' });
    let code: string | null = get('associate_code').toUpperCase() || null;
    let portal = get('portal_user_id') || null;
    if (code && UUID.test(code)) {
      portal = portal || code.toLowerCase();
      code = null;
    }
    const first = seenPhone.get(phone);
    if (first) return repeats_in_file.push({ row, phone, first_row: first });
    if (code && seenCode.has(code)) {
      return code_conflicts.push({
        row,
        code,
        reason: `Same code as row ${seenCode.get(code)} with another phone`,
      });
    }
    seenPhone.set(phone, row);
    if (code) seenCode.set(code, row);
    const email = get('email').toLowerCase();
    items.push({
      row,
      full_name,
      phone,
      associate_code: code,
      portal_user_id: portal,
      email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null,
      designation: get('designation') || null,
      upline: get('upline') || null,
      notes: get('notes') || null,
    });
  });

  const companyId = user.companyId;
  const uplineKeys = items.map((i) => i.upline).filter((v): v is string => !!v);
  const existing = await p.associate.findMany({
    where: {
      company_id: companyId,
      OR: [
        { phone: { in: [...items.map((i) => i.phone), ...uplineKeys.map(tenDigits)] } },
        {
          associate_code: {
            in: [
              ...items.map((i) => i.associate_code).filter((c): c is string => !!c),
              ...uplineKeys.map((u) => u.toUpperCase()),
            ],
          },
        },
      ],
    },
  });
  const exPhone = new Map(existing.map((e) => [e.phone, e]));
  const exCode = new Map(
    existing.filter((e) => e.associate_code).map((e) => [e.associate_code!, e]),
  );
  const all = seesAllAssociates(user);

  const fresh: Item[] = [];
  const already_in_crm: { row: number; id: number; name: string; fills: string[] }[] = [];
  const other_cpm: { row: number; name: string }[] = [];
  const fills = new Map<number, Record<string, string>>();
  for (const it of items) {
    const ex = exPhone.get(it.phone);
    if (ex) {
      if (!all && ex.owner_cpm_id !== null && ex.owner_cpm_id !== user.employeeId) {
        other_cpm.push({ row: it.row, name: ex.full_name });
        continue;
      }
      const f: Record<string, string> = {};
      const codeFree = it.associate_code && !exCode.has(it.associate_code);
      if (!ex.associate_code && codeFree) f.associate_code = it.associate_code!;
      if (!ex.portal_user_id && it.portal_user_id) f.portal_user_id = it.portal_user_id;
      if (!ex.email && it.email) f.email = it.email;
      if (!ex.designation && it.designation) f.designation = it.designation;
      if (Object.keys(f).length) fills.set(ex.id, f);
      already_in_crm.push({ row: it.row, id: ex.id, name: ex.full_name, fills: Object.keys(f) });
      continue;
    }
    if (it.associate_code && exCode.has(it.associate_code)) {
      code_conflicts.push({
        row: it.row,
        code: it.associate_code,
        reason: 'This code belongs to another associate in the CRM',
      });
      continue;
    }
    fresh.push(it);
  }

  // An upline is a code or a phone, in this file or already in the CRM.
  const fileCodes = new Set(fresh.map((i) => i.associate_code).filter(Boolean));
  const filePhones = new Set(items.map((i) => i.phone));
  const upline_unresolved = items
    .filter((i) => i.upline)
    .filter((i) => {
      const u = i.upline!;
      return !(
        exCode.has(u.toUpperCase()) ||
        exPhone.has(tenDigits(u)) ||
        fileCodes.has(u.toUpperCase()) ||
        filePhones.has(tenDigits(u))
      );
    })
    .map((i) => ({ row: i.row, upline: i.upline! }));

  // Every spreadsheet row with what will happen to it, in file order (for the preview table).
  type RowStatus = 'NEW' | 'EXISTS' | 'REPEAT' | 'PROBLEM' | 'CLASH' | 'OTHER';
  const rowsOut = new Map<
    number,
    { row: number; name: string; phone: string; status: RowStatus; note: string }
  >();
  const put = (row: number, status: RowStatus, note: string) =>
    rowsOut.set(row, {
      row,
      name: shown.get(row)?.name || '',
      phone: shown.get(row)?.phone || '',
      status,
      note,
    });
  for (const i of fresh)
    put(
      i.row,
      'NEW',
      i.associate_code ? `Will be added as joined (ID ${i.associate_code})` : 'Will be added',
    );
  for (const r of already_in_crm)
    put(
      r.row,
      'EXISTS',
      r.fills.length
        ? `Already added. Will fill in: ${r.fills.join(', ')}`
        : 'Already added, nothing to change',
    );
  for (const r of repeats_in_file)
    put(r.row, 'REPEAT', `Same mobile as row ${r.first_row}, skipped`);
  for (const r of invalid) put(r.row, 'PROBLEM', r.reason);
  for (const r of code_conflicts) put(r.row, 'CLASH', r.reason);
  for (const r of other_cpm) put(r.row, 'OTHER', 'Already looked after by someone else, skipped');
  const rows = [...rowsOut.values()].sort((a, b) => a.row - b.row);

  return {
    items,
    fresh,
    fills,
    summary: {
      rows,
      total_rows: table.length - 1,
      new_count: fresh.length,
      already_in_crm_count: already_in_crm.length,
      repeat_count: repeats_in_file.length,
      invalid_count: invalid.length,
      code_conflict_count: code_conflicts.length,
      other_cpm_count: other_cpm.length,
      new_sample: fresh.slice(0, 50).map((i) => ({
        row: i.row,
        name: i.full_name,
        phone: i.phone,
        code: i.associate_code,
        designation: i.designation,
        upline: i.upline,
      })),
      already_in_crm: already_in_crm.slice(0, 200),
      repeats_in_file: repeats_in_file.slice(0, 200),
      invalid: invalid.slice(0, 200),
      code_conflicts: code_conflicts.slice(0, 200),
      other_cpm: other_cpm.slice(0, 200),
      upline_unresolved: upline_unresolved.slice(0, 200),
      ignored_columns,
    },
  };
}

export async function previewImport(user: TokenPayload, csv: string) {
  return (await planImport(user, csv)).summary;
}

export async function commitImport(
  user: TokenPayload,
  csv: string,
  opts: { source?: string; owner_cpm_id?: number | null },
) {
  const plan = await planImport(user, csv);
  const companyId = user.companyId;
  // A CPM adds for themselves. The MD, Admin and Technical Manager choose a CPM, or nobody yet.
  const owner = seesAllAssociates(user) ? (opts.owner_cpm_id ?? null) : user.employeeId;
  if (owner !== null) {
    const ok = await p.employee.findFirst({
      where: {
        id: owner,
        company_id: companyId,
        status: 'ACTIVE',
        roles: { some: { role: { name: Roles.CHANNEL_PARTNER_MANAGER } } },
      },
    });
    if (!ok) throw new AppError(400, 'Choose an active Channel Partner Manager of this company.');
  }
  const source = opts.source === 'PORTAL_EXPORT' ? 'PORTAL_EXPORT' : 'SPREADSHEET';
  let created = 0;
  for (let i = 0; i < plan.fresh.length; i += 200) {
    const r = await p.associate.createMany({
      data: plan.fresh.slice(i, i + 200).map((it) => ({
        company_id: companyId,
        full_name: it.full_name,
        phone: it.phone,
        associate_code: it.associate_code,
        portal_user_id: it.portal_user_id,
        email: it.email,
        designation: it.designation,
        notes: it.notes,
        // A portal code means they were enrolled there already.
        pipeline: it.associate_code ? 'ENROLLED' : 'INVITED',
        owner_cpm_id: owner,
        source,
        created_by_id: user.employeeId,
      })),
      skipDuplicates: true,
    });
    created += r.count;
  }
  let updated = 0;
  for (const [id, data] of plan.fills) {
    await p.associate.update({ where: { id }, data });
    updated++;
  }

  // Uplines last, once everyone in the file exists. Only empty uplines are set.
  let uplines_linked = 0;
  const withUpline = plan.items.filter((i) => i.upline);
  if (withUpline.length) {
    const everyone = await p.associate.findMany({
      where: { company_id: companyId },
      select: { id: true, phone: true, associate_code: true, upline_id: true },
    });
    const parents = new Map(everyone.map((a) => [a.id, a.upline_id]));
    const byPhone = new Map(everyone.map((a) => [a.phone, a]));
    const byCode = new Map(
      everyone.filter((a) => a.associate_code).map((a) => [a.associate_code!, a]),
    );
    for (const it of withUpline) {
      const me = byPhone.get(it.phone);
      const up = byCode.get(it.upline!.toUpperCase()) || byPhone.get(tenDigits(it.upline));
      if (!me || !up || me.upline_id || up.id === me.id || wouldLoop(parents, me.id, up.id))
        continue;
      await p.associate.update({ where: { id: me.id }, data: { upline_id: up.id } });
      parents.set(me.id, up.id);
      me.upline_id = up.id;
      uplines_linked++;
    }
  }
  return { ...plan.summary, created, updated, uplines_linked, owner_cpm_id: owner };
}
