import { logger } from '../utils/logger';
import { Response, Router } from 'express';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { requireAuthz } from '../middleware/authz';
import { Permissions } from '../shared';
import { InventoryService } from '../services/inventory.service';

const router = Router();

// GET /api/v1/inventory - Unified "everything a lead could be matched to or
// book" list: LIVE Property rows + AVAILABLE ProjectUnit rows (in projects
// the caller can see), same shape either way (`kind: 'PROPERTY' | 'UNIT'`).
// See services/inventory.service.ts for why this exists (QA 2026-09-14,
// "every project is a property").
router.get(
  '/',
  authenticateToken,
  requireAuthz(Permissions.PROPERTIES_READ),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { q, location, type, status } = req.query;
      const min_price = req.query.min_price ? Number(req.query.min_price) : undefined;
      const max_price = req.query.max_price ? Number(req.query.max_price) : undefined;
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 200);
      const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);

      const { items, total } = await InventoryService.listInventory(
        req.user!,
        {
          q: typeof q === 'string' ? q : undefined,
          location: typeof location === 'string' ? location : undefined,
          type: typeof type === 'string' ? type : undefined,
          status: status === 'ALL' ? 'ALL' : 'AVAILABLE',
          min_price: Number.isFinite(min_price) ? min_price : undefined,
          max_price: Number.isFinite(max_price) ? max_price : undefined,
        },
        limit,
        offset,
      );

      return res.status(200).json({ items, total, pagination: { limit, offset } });
    } catch (error: any) {
      logger.error('Fetch inventory error:', error);
      return res.status(500).json({ error: 'Failed to fetch inventory' });
    }
  },
);

export default router;
