/**
 * A channel partner's customers from a spreadsheet (2026-11-22; made forgiving 2026-11-26). Marketing people's
 * files come in every shape: any heading words, a title on top, no headings at all, 91 in front of numbers, two
 * numbers in one box, no names. Pure functions, tested without a database.
 */
import { isNameHeading, isPhoneHeading, phoneColumns } from '../shared';

export const CP_LEAD_IMPORT_MAX = 500;
/** Filled lines a file may have: the customers plus titles and headings. */
export const CP_LEAD_IMPORT_MAX_LINES = 510;
const MAX_COLUMNS = 40;

/** A 10-digit Indian mobile number from however it was typed (+91, spaces, a leading 0). Null when it is not one. */
export function normalizeCpPhone(raw: string): string | null {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : null;
}

/** Excel's short form of a long number: the last digits are lost, so it cannot be read back. */
const SHORT_FORM = /^\d(\.\d+)?e\+?\d+$/i;

/** Every mobile number in one box: "98765 43210 / 91234 56780" gives both. */
export function mobilesIn(text: string): string[] {
  const t = String(text || '')
    .trim()
    .replace(/\.0+$/, '');
  if (!t || SHORT_FORM.test(t)) return [];
  const found: (string | null)[] = [];
  for (const part of t.split(/[/,;|&\n]+|\bor\b/i)) {
    const whole = normalizeCpPhone(part);
    if (whole) found.push(whole);
    // Two numbers with only a space between them.
    else if (part.replace(/\D/g, '').length >= 20) {
      const inside = part.match(/(?:\+?91[\s-]*|0)?[6-9]\d{4}[\s-]?\d{5}/g) || [];
      found.push(...inside.map(normalizeCpPhone));
    }
  }
  return [...new Set(found.filter((x): x is string => !!x))];
}

export interface CpLeadRow {
  customer_name: string;
  phone: string;
  alt_phone: string | null;
  email: string | null;
  notes: string | null;
}
export interface CpLeadRowResult {
  /** The line number the person sees in Excel. */
  row: number;
  /** The name as written in the file, to help find a line that needs fixing. */
  name: string;
  lead?: CpLeadRow;
  error?: string;
}
export interface CpLeadSheet {
  /** The line with the column names, or null when the file has none. */
  heading_row: number | null;
  /** False when no column holds mobile numbers. */
  has_phone_column: boolean;
  rows: CpLeadRowResult[];
}

export const NO_NAME = 'No name';

const cell = (v: unknown) => (v === null || v === undefined ? '' : String(v).trim());
/** Only digits and the marks people put around numbers. */
const looksNumeric = (v: string) => /^[\d\s+().\-/,;|&:]+$/.test(v.replace(/\bor\b/gi, ''));
const holdsMobile = (v: string) => looksNumeric(v) && mobilesIn(v).length > 0;
const squash = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, '');
const isEmailHeading = (v: string) => /mail/.test(squash(v));
const isNotesHeading = (v: string) => /note|remark|requirement|comment|feedback/.test(squash(v));
/** Columns whose long numbers are never a customer's mobile. */
const NEVER_PHONE =
  /aadh|account|pin|amount|price|budget|agent|staff|employee|executive|caller|referr|partner|office/;

/** The heading row: the best-looking line above the first mobile number. -1 when the file has none. */
function findHeading(grid: string[][]): number {
  const firstData = grid.findIndex((r) => r.some(holdsMobile));
  const end = Math.min(10, firstData === -1 ? grid.length : firstData);
  let at = -1;
  let best = 0;
  for (let i = 0; i < end; i++) {
    const known = grid[i].filter(
      (c) => isNameHeading(c) || isPhoneHeading(c) || isEmailHeading(c) || isNotesHeading(c),
    ).length;
    const score = known ? known * 100 + grid[i].filter(Boolean).length : 0;
    if (score > best) {
      best = score;
      at = i;
    }
  }
  if (at >= 0) return at;
  // Headings in words we do not know (or another language): a first line of words only, above the numbers.
  const first = grid[0] || [];
  return firstData > 0 && first.filter(Boolean).length > 0 && !first.some((c) => /\d/.test(c))
    ? 0
    : -1;
}

export function readCpLeadSheet(raw: unknown[][]): CpLeadSheet {
  const grid = raw.map((r) => (Array.isArray(r) ? r.slice(0, MAX_COLUMNS).map(cell) : []));
  const headingAt = findHeading(grid);
  const head = headingAt >= 0 ? grid[headingAt] : [];
  const start = headingAt + 1;
  const data = grid.slice(start);
  const width = Math.max(0, ...grid.map((r) => r.length));
  const columns = Array.from({ length: width }, (_, i) => i);
  const stats = columns.map((c) => {
    const values = data.map((r) => r[c] || '').filter(Boolean);
    return {
      filled: values.length,
      mobiles: values.filter(holdsMobile).length,
      words: values.filter((v) => /^[^\d@]{2,60}$/.test(v)).length,
    };
  });

  // Columns named like a phone, then any other column that is mostly mobile numbers.
  const headed = phoneColumns(head);
  const byContent = columns
    .filter(
      (c) =>
        !headed.includes(c) &&
        !NEVER_PHONE.test(squash(head[c] || '')) &&
        !isNameHeading(head[c]) &&
        stats[c].mobiles > 0 &&
        stats[c].mobiles * 2 >= stats[c].filled,
    )
    .sort((a, b) => stats[b].mobiles - stats[a].mobiles);
  const phones = [...headed, ...byContent];

  const named = columns.filter((c) => !phones.includes(c) && isNameHeading(head[c]));
  let nameAt: number | undefined =
    named.find((c) =>
      ['name', 'customername', 'clientname', 'fullname'].includes(squash(head[c])),
    ) ?? named[0];
  // With no headings we know, the first column of mostly words is the name.
  const knowsHeadings = head.some((c) => isNameHeading(c) || isPhoneHeading(c));
  if (nameAt === undefined && !knowsHeadings) {
    nameAt = columns.find(
      (c) => !phones.includes(c) && stats[c].words > 0 && stats[c].words * 2 >= stats[c].filled,
    );
  }
  const emailAt = columns.find((c) => !phones.includes(c) && isEmailHeading(head[c] || ''));
  const noteColumns = columns.filter(
    (c) => c !== nameAt && !phones.includes(c) && isNotesHeading(head[c] || ''),
  );

  const rows: CpLeadRowResult[] = [];
  data.forEach((line, i) => {
    const row = start + i + 1;
    const name = nameAt === undefined ? '' : line[nameAt] || '';
    const written = phones.map((c) => line[c] || '').filter(Boolean);
    if (!name && !written.length) return; // an empty or formatting-only line
    const numbers = [...new Set(written.flatMap(mobilesIn))];
    if (!numbers.length) {
      const error = !written.length
        ? 'No mobile number.'
        : written.some((v) => SHORT_FORM.test(v))
          ? 'Excel cut the number short (like 9.19877E+11). Make the column "Number" in Excel and save again.'
          : `"${written[0].slice(0, 30)}" is not a 10-digit mobile number.`;
      rows.push({ row, name, error });
      return;
    }
    const email = emailAt === undefined ? '' : line[emailAt] || '';
    const notes = noteColumns
      .map((c) => line[c] || '')
      .filter(Boolean)
      .join('; ');
    rows.push({
      row,
      name,
      lead: {
        customer_name: name.length >= 2 ? name.slice(0, 120) : NO_NAME,
        phone: numbers[0],
        alt_phone: numbers[1] ?? null,
        email: email.includes('@') ? email.slice(0, 120) : null,
        notes: notes.slice(0, 2000) || null,
      },
    });
  });

  return {
    heading_row: headingAt >= 0 ? headingAt + 1 : null,
    has_phone_column: phones.length > 0,
    rows,
  };
}

/** The older app sends each line as {heading: value}. Turn that back into lines of boxes. */
export function gridFromObjects(rows: Record<string, unknown>[]): unknown[][] {
  const headings = [...new Set(rows.flatMap((r) => Object.keys(r || {})))];
  return [headings, ...rows.map((r) => headings.map((h) => r?.[h] ?? ''))];
}
