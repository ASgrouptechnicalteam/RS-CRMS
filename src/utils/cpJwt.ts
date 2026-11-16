import crypto from 'crypto';
import jwt from 'jsonwebtoken';

/**
 * External channel partner tokens (item 5, 2026-11-15): their own realm. The
 * secret is derived from JWT_ACCESS_SECRET (no new environment variable), but
 * it is a different key, so a partner token fails authenticateToken on the
 * signature and can never reach a staff route; a staff token fails here on
 * the signature and the audience. Default deny without touching the staff
 * auth middleware.
 */
const AUDIENCE = 'channel-partner';
const ISSUER = 'rrh-crm-cp';

function secret(): string {
  const base = process.env.JWT_ACCESS_SECRET;
  if (!base) throw new Error('FATAL: JWT_ACCESS_SECRET must be provided.');
  return crypto.createHmac('sha256', base).update('channel-partner-v1').digest('hex');
}

export interface CpTokenPayload {
  typ: 'cp';
  employeeId: number;
  companyId: number;
  /** Employee.token_version at sign-in: bumping it ends every session. */
  tv: number;
}

export const generateCpToken = (p: Omit<CpTokenPayload, 'typ'>): string =>
  jwt.sign({ ...p, typ: 'cp' }, secret(), {
    expiresIn: '7d',
    audience: AUDIENCE,
    issuer: ISSUER,
    algorithm: 'HS256',
  });

export const verifyCpToken = (token: string): CpTokenPayload => {
  const payload = jwt.verify(token, secret(), {
    audience: AUDIENCE,
    issuer: ISSUER,
    algorithms: ['HS256'],
  }) as CpTokenPayload;
  if (payload.typ !== 'cp') throw new Error('Not a partner token');
  return payload;
};
