import { Router, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';
import { Roles } from '../shared';
import { AuthenticatedRequest } from '../middleware/auth';
import { requireCp, requireOwner, CpRequest } from './cp';
import { buildCpAdminRouter } from './cpAdmin';

/**
 * The "super admin" partner (2026-11-25), at /api/v1/cp/super. A partner account the MD/Admin has marked as a
 * super admin partner: its owner, and our own employees added to it with Full access, can use the same screens and
 * actions as the Channel partners page (see how every partner is doing, limits, give projects, switch access off or
 * on, add staff) from the partner app, signed in with the partner login. The routes are the very same code as
 * /cp-admin (routes/cpAdmin.ts); only who may call them differs. Looking at another partner's area is read only and
 * is done with the X-View-As header (see requireCp in routes/cp.ts).
 */
const router = Router();

const requireSuper = async (req: CpRequest, res: Response, next: NextFunction) => {
  try {
    // The view-as header never applies here: these routes are about the signed-in super partner itself.
    delete req.headers['x-view-as'];
    next();
  } catch (e) {
    next(e);
  }
};

const mustBeSuperOwner = (req: CpRequest, res: Response, next: NextFunction) =>
  req.cp?.isSuper && !req.cp.user
    ? next()
    : res.status(403).json({ error: 'Only a super admin partner can do this.' });

// The shared routes read who is calling from req.user (company access, the person on the record): here it is
// the super partner's own account, which only has access to its own company.
const asStaff = (req: CpRequest, _res: Response, next: NextFunction) => {
  (req as unknown as AuthenticatedRequest).user = {
    employeeId: req.cp!.id,
    employeeCode: req.cp!.employee_code,
    companyId: req.cp!.company_id,
    branchId: null,
    roles: [Roles.CHANNEL_PARTNER_EXTERNAL],
    permissions: [],
  } as any;
  next();
};

void prisma;

router.use(
  buildCpAdminRouter(
    [
      requireSuper as any,
      requireCp as any,
      requireOwner as any,
      mustBeSuperOwner as any,
      asStaff as any,
    ],
    false,
  ),
);

export default router;
