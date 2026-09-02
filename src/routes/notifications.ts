import { logger } from '../utils/logger';
import { Router, Response } from 'express';
import { prisma } from '../lib/prisma';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';

const router = Router();

const p = prisma;

// GET /api/v1/notifications - List notifications for logged in user
router.get('/', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.employeeId;

    const notifications = await p.notification.findMany({
      where: { employee_id: userId },
      orderBy: { created_at: 'desc' },
      take: 20,
    });

    const unreadCount = notifications.filter((n: any) => !n.is_read).length;

    return res.status(200).json({ notifications, unreadCount });
  } catch (error) {
    logger.error('Failed to fetch notifications:', error);
    return res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

// PATCH /api/v1/notifications/:id/read - Mark notification as read
router.patch('/:id/read', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const notificationId = parseInt(req.params.id, 10);
    const userId = req.user!.employeeId;

    const notification = await p.notification.findUnique({
      where: { id: notificationId },
    });

    if (!notification) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    if (notification.employee_id !== userId && notification.employee_id !== userId) {
      return res.status(403).json({ error: 'Forbidden: Cannot access another user\'s notification' });
    }

    const updated = await p.notification.update({
      where: { id: notificationId },
      data: { is_read: true },
    });

    return res.status(200).json({ message: 'Marked as read', notification: updated });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to update notification' });
  }
});

export default router;
