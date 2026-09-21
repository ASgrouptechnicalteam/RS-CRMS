import { z } from 'zod';

/**
 * Treat an empty (or whitespace-only) string as "not provided".
 *
 * HTML forms submit "" for every input the user left untouched. A field like
 * `bank_ifsc: z.string().regex(IFSC).optional()` therefore rejects the whole
 * submit ("Invalid IFSC format") even though the user never typed anything —
 * `.optional()` only accepts `undefined`, and "" still has to pass the regex.
 *
 * Wrap such fields with this helper. The blank is mapped to `null` when the
 * wrapped schema accepts null (so an edit form can clear a stored value) and
 * to `undefined` otherwise (field simply omitted). Non-blank input is passed
 * through untouched and still has to satisfy the schema's constraints.
 *
 * Do NOT use this on identity/required fields (name, phone) whose blank
 * submission genuinely should be rejected.
 */
export function blankAsAbsent<T extends z.ZodTypeAny>(schema: T) {
  const absent = schema.safeParse(null).success ? null : undefined;
  return z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? absent : value),
    schema,
  );
}
