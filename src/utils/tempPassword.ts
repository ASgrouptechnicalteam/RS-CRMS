import crypto from 'crypto';

const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O — avoid look-alikes in a password an admin reads aloud
const LOWER = 'abcdefghijkmnopqrstuvwxyz'; // no l
const DIGITS = '23456789'; // no 0/1
const SPECIAL = '!@#$%&*';
const ALL = UPPER + LOWER + DIGITS + SPECIAL;

const randomChar = (charset: string): string => charset[crypto.randomInt(charset.length)];

/**
 * A fresh, unpredictable temporary password for a new/reset employee account —
 * satisfies the same complexity rules as EmployeeCreateSchema/ChangePasswordSchema
 * (upper, lower, digit, special char). Every call produces a different value, so
 * no shared/guessable default password exists across the system; first_login_done
 * is set to false alongside it, forcing the employee to pick their own on first login.
 */
export const generateTemporaryPassword = (length = 12): string => {
  const required = [randomChar(UPPER), randomChar(LOWER), randomChar(DIGITS), randomChar(SPECIAL)];
  const rest = Array.from({ length: length - required.length }, () => randomChar(ALL));
  const chars = [...required, ...rest];

  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }

  return chars.join('');
};
