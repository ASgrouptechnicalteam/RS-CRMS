import { Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';
import {
  associatePasswordFingerprint,
  associateRealmConfigured,
  verifyAssociateToken,
} from '../utils/associateJwt';

/** The whole associate app is absent unless ASSOCIATE_PORTAL_ENABLED=true. */
export const associatePortalSwitch = (_req: Request, res: Response, next: NextFunction) => {
  if (process.env.ASSOCIATE_PORTAL_ENABLED !== 'true') {
    return res.status(404).json({ error: 'API route not found' });
  }
  if (!associateRealmConfigured()) {
    return res.status(503).json({ error: 'The associate app is not set up yet.' });
  }
  next();
};

/** Attaches req.associate for a valid associate token. It stops working when
 * the password changes or the associate has left. While the temporary
 * password is in use, only routes marked `allowTemporary` are reachable. */
export const requireAssociate =
  (opts: { allowTemporary?: boolean } = {}) =>
  async (req: any, res: Response, next: NextFunction) => {
    const header = req.header('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) return res.status(401).json({ error: 'Please log in' });

    let payload;
    try {
      payload = verifyAssociateToken(token);
    } catch {
      return res.status(401).json({ error: 'Your session has expired. Please log in again.' });
    }

    try {
      const associate = await prisma.associate.findUnique({
        where: { id: payload.associateId },
        include: { credential: true },
      });
      if (
        !associate ||
        !associate.credential ||
        associate.company_id !== payload.companyId ||
        associate.pipeline === 'LEFT' ||
        associatePasswordFingerprint(associate.credential.password_hash) !== payload.pwf
      ) {
        return res.status(401).json({ error: 'Your session has expired. Please log in again.' });
      }
      if (associate.credential.force_password_change && !opts.allowTemporary) {
        return res
          .status(403)
          .json({ error: 'Please set your own password first.', code: 'PASSWORD_CHANGE_REQUIRED' });
      }
      req.associate = associate;
      next();
    } catch (err) {
      next(err);
    }
  };
