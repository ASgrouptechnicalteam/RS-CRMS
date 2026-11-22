import { parseImportAmount, parseImportDate } from './pettyCashImport';

/**
 * Payments received import (diary D28, 2026-11-22): rows from a spreadsheet, the
 * CRM template or a Tally receipt list, checked into payment records. Every
 * imported payment is saved as PENDING, exactly like one typed in by hand, so
 * Finance verifies it in the same queue and the booking balance moves only then.
 */

export const PAYMENT_IMPORT_MAX_ROWS = 500;
export const PAYMENT_METHODS = ['CASH', 'CHEQUE', 'BANK_TRANSFER', 'ONLINE'] as const;
export type PaymentMethodValue = (typeof PAYMENT_METHODS)[number];

export interface PaymentImportEntry {
  booking_code: string;
  payment_date: string; // YYYY-MM-DD
  amount: number;
  payment_method: PaymentMethodValue;
  reference_number: string | null;
  notes: string | null;
}

export interface PaymentRowResult {
  row: number;
  entry?: PaymentImportEntry;
  error?: string;
}

const ALIASES: Record<string, string[]> = {
  booking: ['bookingcode', 'booking', 'bookingno', 'bookingnumber', 'bookingref'],
  date: ['date', 'paymentdate', 'receiptdate', 'voucherdate'],
  amount: ['amount', 'credit', 'creditamount', 'receipt', 'amountreceived', 'received'],
  method: ['method', 'paymentmethod', 'mode', 'paymentmode', 'modeofpayment'],
  reference: [
    'reference',
    'referenceno',
    'referencenumber',
    'chequeno',
    'utr',
    'transactionid',
    'voucherno',
    'vouchernumber',
  ],
  note: ['note', 'notes', 'narration', 'remarks', 'description'],
};

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function pick(row: Record<string, unknown>, field: keyof typeof ALIASES): string {
  for (const [key, value] of Object.entries(row)) {
    if (ALIASES[field].includes(squash(key)) && value !== null && value !== undefined) {
      const text = String(value).trim();
      if (text) return text;
    }
  }
  return '';
}

/** Cash, cheque, bank transfer or online, from the words people and Tally use. Null when not understood. */
export function parseMethod(raw: string): PaymentMethodValue | null {
  const s = squash(raw);
  if (!s) return null;
  if (/^(cash|cashreceipt)$/.test(s)) return 'CASH';
  if (/^(cheque|check|chq|dd|demanddraft)$/.test(s)) return 'CHEQUE';
  if (/^(banktransfer|bank|neft|rtgs|imps|transfer|wire|banking|bankreceipt)$/.test(s))
    return 'BANK_TRANSFER';
  if (/^(online|upi|gpay|phonepe|paytm|card|netbanking|gateway)$/.test(s)) return 'ONLINE';
  return null;
}

/** Turns spreadsheet rows into payments to record, or a plain reason per row. */
export function readPaymentRows(
  rows: Record<string, unknown>[],
  today: string,
): PaymentRowResult[] {
  return rows.map((raw, i) => {
    const row = i + 2;
    const booking = pick(raw, 'booking').toUpperCase();
    if (!booking)
      return { row, error: 'The booking code is missing (for example RRH-BK-2026-00012).' };
    const date = parseImportDate(pick(raw, 'date'));
    if (!date) return { row, error: 'The date is missing or not readable (use DD-MM-YYYY).' };
    if (date > today) return { row, error: 'The date is in the future.' };
    const amount = parseImportAmount(pick(raw, 'amount'));
    if (amount === null || amount <= 0)
      return { row, error: 'The amount is missing or not more than 0.' };
    if (amount > 999999999) return { row, error: 'The amount is too large.' };
    const methodText = pick(raw, 'method');
    const method = parseMethod(methodText);
    if (!method)
      return {
        row,
        error: methodText
          ? `Method "${methodText}" is not known. Use Cash, Cheque, Bank transfer or Online.`
          : 'The method is missing. Use Cash, Cheque, Bank transfer or Online.',
      };
    const reference = pick(raw, 'reference').slice(0, 100) || null;
    if (method === 'CHEQUE' && !reference)
      return { row, error: 'A cheque needs its cheque number in Reference.' };
    const note = pick(raw, 'note');
    return {
      row,
      entry: {
        booking_code: booking,
        payment_date: date,
        amount: Math.round(amount * 100) / 100,
        payment_method: method,
        reference_number: reference,
        notes: ['Imported from a file', note].filter(Boolean).join('. ').slice(0, 1000),
      },
    };
  });
}

/** The same payment typed twice: same booking, day, amount, method and reference. */
export const paymentKey = (e: {
  booking_code: string;
  payment_date: string;
  amount: number;
  payment_method: string;
  reference_number?: string | null;
}) =>
  [
    e.booking_code.toUpperCase(),
    e.payment_date,
    e.amount.toFixed(2),
    e.payment_method,
    (e.reference_number || '').toLowerCase(),
  ].join('|');
