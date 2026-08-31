import { Request, Response, NextFunction } from 'express';
import { can } from '../authz/authorization';
import { AuthenticatedRequest } from './auth';
import { Permission } from '../shared';

/**
 * requireAuthz Middleware
 * Replaces simple requireRole/requirePermission checks with the new centralized 'can' engine.
 * @param action The required permission action.
 * @param getResource An optional async function to fetch the specific resource being accessed.
 */
export const requireAuthz = (
  action: Permission,
  getResource?: (req: AuthenticatedRequest) => Promise<any>
) => {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: 'Unauthenticated', code: 'UNAUTHORIZED' });
      }

      let resource = undefined;
      if (getResource) {
        resource = await getResource(req);
        if (!resource) {
          // If a resource is expected but not found, 404 is more appropriate than 403
          return res.status(404).json({ error: 'Resource not found', code: 'NOT_FOUND' });
        }
      }

      const isAuthorized = can(req.user, action, resource);
      
      if (!isAuthorized) {
        return res.status(403).json({ error: 'Forbidden: Insufficient access or out of scope', code: 'FORBIDDEN' });
      }

      // We attach the authorized resource to the request so downstream routes don't have to fetch it again
      if (resource) {
        (req as any).authorizedResource = resource;
      }

      next();
    } catch (err) {
      next(err);
    }
  };
};
