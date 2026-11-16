import crypto from 'crypto';
import jwt from 'jsonwebtoken';

// Associate app tokens: their own realm, apart from employee tokens
// (utils/jwt.ts) and customer tokens (utils/customerJwt.ts). Unlike the
// customer secret this one is NOT derived from JWT_ACCESS_SECRET: it comes
// from its own environment variable, so a leak or rotation of one realm
// never touches the other. The token carries no roles or permissions, so it
// can never satisfy authenticateToken / requireRole, and an employee token
// fails here on both the secret and the audience.

const AUDIENCE = 'associate-app';
const ISSUER = 'rrh-crm-associate';

/** The secret, or null when it is missing, too short, or reused from another realm. */
function secret(): string | null {
  const s = process.env.ASSOCIATE_JWT_SECRET || '';
  if (s.length < 32) return null;
  if (
    [
      process.env.JWT_ACCESS_SECRET,
      process.env.JWT_REFRESH_SECRET,
      process.env.WEBSITE_JWT_SECRET,
    ].includes(s)
  ) {
    return null;
  }
  return s;
}

export const associateRealmConfigured = () => secret() !== null;

export interface AssociateTokenPayload {
  typ: 'associate';
  associateId: number;
  companyId: number;
  /** Fingerprint of the password hash: a new password ends every old session. */
  pwf: string;
  mustChange: boolean;
}

export const associatePasswordFingerprint = (hash: string): string =>
  crypto.createHash('sha256').update(`associate:${hash}`).digest('hex').slice(0, 16);

export const generateAssociateToken = (payload: Omit<AssociateTokenPayload, 'typ'>): string => {
  const s = secret();
  if (!s) throw new Error('ASSOCIATE_JWT_SECRET is not configured');
  return jwt.sign({ ...payload, typ: 'associate' }, s, {
    expiresIn: '7d',
    audience: AUDIENCE,
    issuer: ISSUER,
    algorithm: 'HS256',
  });
};

export const verifyAssociateToken = (token: string): AssociateTokenPayload => {
  const s = secret();
  if (!s) throw new Error('ASSOCIATE_JWT_SECRET is not configured');
  const payload = jwt.verify(token, s, {
    audience: AUDIENCE,
    issuer: ISSUER,
    algorithms: ['HS256'],
  }) as AssociateTokenPayload;
  if (payload.typ !== 'associate' || !Number.isInteger(payload.associateId)) {
    throw new Error('Not an associate token');
  }
  return payload;
};
