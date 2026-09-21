import { Router, Response } from 'express';
import { prisma } from '../lib/prisma';
import { authenticateToken, AuthenticatedRequest, requireRole } from '../middleware/auth';
import { Roles } from '../shared';
import { z } from 'zod';
import { logger } from '../utils/logger';

const router = Router();
const p = prisma;

const AdjustScoreSchema = z.object({
  employeeId: z.number().int().positive(),
  points: z.number(),
  reason: z.string().min(5, 'Reason must be at least 5 characters long'),
});

router.post(
  '/',
  authenticateToken,
  requireRole([Roles.HR_MANAGER, Roles.MD, Roles.ADMIN]),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const body = AdjustScoreSchema.safeParse(req.body);
      if (!body.success) {
        return res.status(400).json({ error: body.error.errors[0].message });
      }

      const { employeeId, points, reason } = body.data;
      const adjusterId = req.user!.employeeId;

      // Verify employee exists
      const employee = await p.employee.findUnique({
        where: { id: employeeId },
      });

      if (!employee) {
        return res.status(404).json({ error: 'Employee not found' });
      }

      const adjustment = await p.performanceAdjustment.create({
        data: {
          employee_id: employeeId,
          adjuster_id: adjusterId,
          points,
          reason,
        },
      });

      logger.info(
        `Performance adjustment created for employee ${employeeId} by ${adjusterId}: ${points} pts`,
      );

      return res.status(201).json({ message: 'Score adjusted successfully', adjustment });
    } catch (error) {
      logger.error('Error creating performance adjustment:', error);
      return res.status(500).json({ error: 'Failed to adjust score' });
    }
  },
);

export default router;
