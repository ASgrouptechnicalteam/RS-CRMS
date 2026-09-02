import { Router, Response } from 'express';
import { prisma } from '../lib/prisma';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { requireAuthz } from '../middleware/authz';
import { Permissions } from '../shared';

const router = Router();

// GET /api/v1/roles - List all roles (used by Role Assignment Page)
router.get('/', authenticateToken, requireAuthz(Permissions.EMPLOYEES_READ), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const roles = await prisma.role.findMany({
      orderBy: { name: 'asc' },
    });
    
    return res.status(200).json({ roles });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to fetch roles' });
  }
});

export default router;
