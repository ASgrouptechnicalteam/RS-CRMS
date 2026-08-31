import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET;
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;

if (!JWT_ACCESS_SECRET || !JWT_REFRESH_SECRET) {
  throw new Error('FATAL: JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be provided.');
}

export interface TokenPayload {
  employeeId: number;
  employeeCode: string;
  companyId: number;
  branchId: number | null;
  roles: string[];
  permissions: string[];
  tokenVersion?: number;
  /** Kiosk-only fields — only present when type === 'KIOSK' */
  type?: 'KIOSK' | 'EMPLOYEE';
  kioskCredentialId?: number;
  credentialVersion?: number;
  createdAt?: number;
}

export const generateAccessToken = (payload: TokenPayload): string => {
  const finalPayload = {
    ...payload,
    tokenVersion: payload.tokenVersion ?? 1,
  };
  return jwt.sign(finalPayload, JWT_ACCESS_SECRET, { expiresIn: '24h' });
};

export const generateRefreshToken = (payload: TokenPayload): string => {
  return jwt.sign(payload, JWT_REFRESH_SECRET, { expiresIn: '7d', jwtid: crypto.randomUUID() });
};

export const verifyAccessToken = (token: string): TokenPayload => {
  return jwt.verify(token, JWT_ACCESS_SECRET) as TokenPayload;
};

export const verifyRefreshToken = (token: string): TokenPayload => {
  return jwt.verify(token, JWT_REFRESH_SECRET) as TokenPayload;
};
