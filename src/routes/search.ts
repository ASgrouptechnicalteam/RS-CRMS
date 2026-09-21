import { Router, Response } from 'express';
import { prisma } from '../lib/prisma';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';

const router = Router();

router.get('/', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const q = (req.query.q as string) || '';
    if (!q || q.length < 2) {
      return res.status(200).json({ leads: [], bookings: [], projects: [] });
    }

    const companyId = req.user!.companyId;

    // Search Leads
    const leads = await prisma.lead.findMany({
      where: {
        company_id: companyId,
        OR: [
          { customer_name: { contains: q } },
          { phone: { contains: q } },
          { email: { contains: q } },
        ],
      },
      take: 5,
      select: { id: true, customer_name: true, phone: true, status: true },
    });

    // Search Bookings
    const bookings = await prisma.booking.findMany({
      where: {
        company_id: companyId,
        booking_code: { contains: q },
      },
      take: 5,
      select: {
        id: true,
        booking_code: true,
        status: true,
        customer: { select: { first_name: true, last_name: true } },
      },
    });

    // Search Projects
    const projects = await prisma.project.findMany({
      where: {
        company_id: companyId,
        name: { contains: q },
      },
      take: 5,
      select: { id: true, name: true, status: true },
    });

    return res.status(200).json({ leads, bookings, projects });
  } catch (error) {
    return res.status(500).json({ error: 'Search failed' });
  }
});

export default router;
