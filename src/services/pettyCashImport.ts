import { EXPENSE_CATEGORIES } from '../shared';

/**
 * Petty cash import (diary D28, 2026-11-21): rows from a spreadsheet, the CRM's
 * own template or a Tally export, turned into petty cash entries. Pure
 * functions only, so every rule is tested without a database.
 */

export const IMPORT_MAX_ROWS = 1000;
const TOP_UP_SOURCES = ['BANK', 'UPI', 'CASH', 'CHEQUE', 'OTHER'] as const;

export interface ImportEntry {
  entry_date: string; // YYYY-MM-DD
  type: 'EXPENSE' | 'TOP_UP' | 'ADJUSTMENT';
  amount: number;
  category: string | null;
  source: string | null;
  note: string | null;
  paid_to: string | null;
  bill_no: string | null;
}

export interface ImportRowResult {
  row: number; // the spreadsheet line (header is line 1)
  entry?: ImportEntry;
  error?: string;
}

// Header names this importer understands (lower case, letters and digits only), CRM template first, Tally after.
const ALIASES: Record<string, string[]> = {
  date: ['date', 'voucherdate', 'entrydate'],
  type: ['type', 'entrytype', 'vouchertype'],
  amount: ['amount'],
  debit: ['debit', 'debitamount', 'payment', 'withdrawal', 'moneyout'],
  credit: ['credit', 'creditamount', 'receipt', 'deposit', 'moneyin'],
  category: ['category', 'ledger', 'expensecategory', 'ledgername'],
  source: ['source', 'topupsource'],
  note: ['note', 'narration', 'remarks', 'description'],
  paid_to: ['paidto', 'party', 'partyname', 'particulars'],
  bill_no: ['billno', 'bill', 'voucherno', 'vouchernumber', 'invoiceno'],
};

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Reads one cell by any of its accepted header names. */
function pick(row: Record<string, unknown>, field: keyof typeof ALIASES): string {
  for (const [key, value] of Object.entries(row)) {
    if (ALIASES[field].includes(squash(key)) && value !== null && value !== undefined) {
      const text = String(value).trim();
      if (text) return text;
    }
  }
  return '';
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** YYYY-MM-DD from 2026-11-03, 03-11-2026, 03/11/2026, 3-Nov-2026 or an Excel day number. Null when unreadable. */
export function parseImportDate(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  let y: number, m: number, d: number;
  let hit: RegExpMatchArray | null;
  if ((hit = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) [y, m, d] = [+hit[1], +hit[2], +hit[3]];
  else if ((hit = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/)))
    [d, m, y] = [+hit[1], +hit[2], +hit[3]];
  else if ((hit = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3})[A-Za-z]*[-\s,]+(\d{2,4})$/))) {
    d = +hit[1];
    m = MONTHS.indexOf(hit[2].toLowerCase()) + 1;
    y = +hit[3] < 100 ? 2000 + +hit[3] : +hit[3];
  } else if (/^\d{5}$/.test(s)) {
    // Excel stores a date as the days since 1899-12-30.
    const dt = new Date(Date.UTC(1899, 11, 30) + Number(s) * 86400000);
    [y, m, d] = [dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()];
  } else return null;
  if (!m || m > 12 || !d || d > 31 || y < 2000 || y > 2100) return null;
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCMonth() !== m - 1) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** 1,25,000.50 or ₹ 500 or (500) to a number; null when not a number. */
export function parseImportAmount(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  const negative = /^\(.*\)$/.test(s) || /^-/.test(s);
  const n = Number(s.replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

const categoryFor = (raw: string): { category: string; extraNote: string | null } => {
  const wanted = squash(raw);
  const hit = EXPENSE_CATEGORIES.find((c) => squash(c) === wanted);
  if (hit) return { category: hit, extraNote: null };
  // A Tally ledger the CRM does not have: filed under Other, with the ledger name kept in the note.
  return { category: 'Other', extraNote: raw ? `Ledger: ${raw}` : null };
};

/** Turns spreadsheet rows into entries or a plain reason per row. `today` is the IST date (no future dates). */
export function readImportRows(rows: Record<string, unknown>[], today: string): ImportRowResult[] {
  return rows.map((raw, i) => {
    const row = i + 2;
    const date = parseImportDate(pick(raw, 'date'));
    if (!date) return { row, error: 'The date is missing or not readable (use DD-MM-YYYY).' };
    if (date > today) return { row, error: 'The date is in the future.' };

    // Amount: one Amount column with a Type, or Tally's Debit (money out) and Credit (money in) columns.
    const typeText = squash(pick(raw, 'type'));
    const debit = parseImportAmount(pick(raw, 'debit'));
    const credit = parseImportAmount(pick(raw, 'credit'));
    let amount = parseImportAmount(pick(raw, 'amount'));
    let type: ImportEntry['type'] | null = null;
    let opening = false;
    if (/^(opening|openingbalance|opening bal)/.test(typeText)) {
      type = 'TOP_UP';
      opening = true;
    } else if (/^(expense|expenses|payment|debit|spend|spent|out)$/.test(typeText))
      type = 'EXPENSE';
    else if (/^(topup|topups|receipt|credit|cashin|deposit|in)$/.test(typeText)) type = 'TOP_UP';
    else if (/^(adjustment|adjust|correction)$/.test(typeText)) type = 'ADJUSTMENT';
    else if (typeText)
      return {
        row,
        error: `Type "${pick(raw, 'type')}" is not known. Use Expense, Top-up, Adjustment or Opening balance.`,
      };
    if (!type) {
      if (debit && debit > 0 && !(credit && credit > 0)) [type, amount] = ['EXPENSE', debit];
      else if (credit && credit > 0 && !(debit && debit > 0)) [type, amount] = ['TOP_UP', credit];
      else
        return {
          row,
          error: 'Say the type (Expense, Top-up, Adjustment) or fill one of Debit or Credit.',
        };
    }
    if (amount === null || amount === 0 || Number.isNaN(amount))
      return { row, error: 'The amount is missing or zero.' };
    if (type !== 'ADJUSTMENT' && amount < 0)
      return { row, error: 'The amount must be more than 0.' };
    if (Math.abs(amount) > 99999999) return { row, error: 'The amount is too large.' };

    const note = pick(raw, 'note');
    const entry: ImportEntry = {
      entry_date: date,
      type,
      amount: Math.round(amount * 100) / 100,
      category: null,
      source: null,
      note: note || null,
      paid_to: pick(raw, 'paid_to').slice(0, 120) || null,
      bill_no: pick(raw, 'bill_no').slice(0, 60) || null,
    };
    if (type === 'EXPENSE') {
      const { category, extraNote } = categoryFor(pick(raw, 'category'));
      entry.category = category;
      if (category === 'Other') {
        entry.note = [extraNote, note].filter(Boolean).join('. ') || null;
        if (!entry.note || entry.note.length < 3)
          return { row, error: 'Category Other needs a note (what was it for?).' };
      }
    } else if (type === 'TOP_UP') {
      const src = pick(raw, 'source')
        .toUpperCase()
        .replace(/[^A-Z]/g, '');
      const source = (TOP_UP_SOURCES as readonly string[]).includes(src)
        ? src
        : opening
          ? 'OTHER'
          : 'CASH';
      entry.source = source;
      if (opening) entry.note = ['Opening balance', note].filter(Boolean).join('. ');
      else if (source === 'OTHER' && (!entry.note || entry.note.length < 3))
        return { row, error: 'Source Other needs a note (where did the money come from?).' };
    } else if (!entry.note || entry.note.length < 3) {
      return { row, error: 'An adjustment needs a note saying why.' };
    }
    if (entry.note) entry.note = entry.note.slice(0, 1000);
    return { row, entry };
  });
}

/** The same entry typed twice: same day, kind, amount, bill number and payee. */
export const entryKey = (e: {
  entry_date: string;
  type: string;
  amount: number;
  bill_no?: string | null;
  paid_to?: string | null;
}) =>
  [
    e.entry_date,
    e.type,
    e.amount.toFixed(2),
    (e.bill_no || '').toLowerCase(),
    (e.paid_to || '').toLowerCase(),
  ].join('|');
