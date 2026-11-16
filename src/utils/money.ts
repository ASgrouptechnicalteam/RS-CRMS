/**
 * Money helpers. Money columns are exact decimals in the database
 * (DECIMAL(14,2)); in code they are worked on as numbers rounded to paise.
 * `num` accepts a number, a numeric string or a Prisma Decimal.
 */
export const num = (v: unknown): number => {
  if (v == null) return 0;
  const n = typeof v === 'number' ? v : Number(v.toString());
  return Number.isFinite(n) ? n : 0;
};

/** Round to paise, so sums of rupee amounts never drift (0.1 + 0.2). */
export const round2 = (v: unknown): number => Math.round(num(v) * 100) / 100;

export const inr = (v: unknown): string =>
  '₹' + round2(v).toLocaleString('en-IN', { maximumFractionDigits: 2 });
