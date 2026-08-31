import crypto from 'crypto';

const QR_HMAC_SECRET = process.env.QR_HMAC_SECRET;
if (!QR_HMAC_SECRET) {
  throw new Error('QR_HMAC_SECRET is not configured');
}

export interface QrTokenPayload {
  employeeId: number;
  employeeCode: string;
  version: number;
  signedToken: string;
}

export const generateQrHmac = (employeeId: number, employeeCode: string, version: number = 1): string => {
  const data = `${employeeId}:${employeeCode}:${version}`;
  return crypto.createHmac('sha256', QR_HMAC_SECRET).update(data).digest('hex');
};

export const verifyQrHmac = (employeeId: number, employeeCode: string, version: number, signature: string): boolean => {
  if (!signature) return false;
  const expected = generateQrHmac(employeeId, employeeCode, version);
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
};
