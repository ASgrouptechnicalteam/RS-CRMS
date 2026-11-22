/**
 * A channel partner's leads from a spreadsheet (2026-11-22). Pure functions, tested without a database.
 */

export const CP_LEAD_IMPORT_MAX = 500;

/** A 10-digit Indian mobile number from however it was typed (+91, spaces, a leading 0). Null when it is not one. */
export function normalizeCpPhone(raw: string): string | null {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : null;
}

export interface CpLeadRow {
  customer_name: string;
  phone: string;
  email: string | null;
  notes: string | null;
}
export interface CpLeadRowResult {
  row: number;
  lead?: CpLeadRow;
  error?: string;
}

const ALIASES: Record<string, string[]> = {
  name: ['name', 'customername', 'customer', 'fullname', 'clientname'],
  phone: [
    'phone',
    'mobile',
    'mobileno',
    'mobilenumber',
    'phonenumber',
    'contact',
    'contactnumber',
    'whatsapp',
  ],
  email: ['email', 'emailid', 'mail'],
  notes: ['notes', 'note', 'remarks', 'requirement', 'comment', 'comments'],
};
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const pick = (row: Record<string, unknown>, field: keyof typeof ALIASES) => {
  for (const [key, value] of Object.entries(row)) {
    if (ALIASES[field].includes(squash(key)) && value !== null && value !== undefined) {
      const text = String(value).trim();
      if (text) return text;
    }
  }
  return '';
};

export function readCpLeadRows(rows: Record<string, unknown>[]): CpLeadRowResult[] {
  return rows.map((raw, i) => {
    const row = i + 2;
    const name = pick(raw, 'name');
    if (name.length < 2) return { row, error: 'The name is missing.' };
    const phone = normalizeCpPhone(pick(raw, 'phone'));
    if (!phone) return { row, error: 'The phone is missing or is not a 10-digit mobile number.' };
    const email = pick(raw, 'email');
    return {
      row,
      lead: {
        customer_name: name.slice(0, 120),
        phone,
        email: email ? email.slice(0, 120) : null,
        notes: pick(raw, 'notes').slice(0, 2000) || null,
      },
    };
  });
}
