import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';

/**
 * Sweeps for site visits scheduled for the next calendar day (IST)
 * and sends a notification to the assigned telecaller (and PM if assigned)
 * to reconfirm the visit with the customer.
 */
export const siteVisitReconfirmReminderJob = async () => {
  logger.info('[visitReminders] Starting daily T-1 site visit reminder sweep...');

  try {
    // Determine the boundaries for "tomorrow" in IST (+05:30)
    // We get current UTC time, add 24 hours to get "tomorrow", then calculate
    // the start and end of that day in IST.
    const nowUtc = new Date();

    // Convert to IST
    const istTime = new Date(nowUtc.getTime() + 5.5 * 60 * 60 * 1000);

    // Add 1 day to get tomorrow
    const tomorrowIst = new Date(istTime.getTime() + 24 * 60 * 60 * 1000);

    // Start of tomorrow IST (00:00:00.000)
    const startOfTomorrowIst = new Date(tomorrowIst);
    startOfTomorrowIst.setUTCHours(0, 0, 0, 0);

    // End of tomorrow IST (23:59:59.999)
    const endOfTomorrowIst = new Date(tomorrowIst);
    endOfTomorrowIst.setUTCHours(23, 59, 59, 999);

    // Convert back to UTC for Prisma queries
    const startOfTomorrowUtc = new Date(startOfTomorrowIst.getTime() - 5.5 * 60 * 60 * 1000);
    const endOfTomorrowUtc = new Date(endOfTomorrowIst.getTime() - 5.5 * 60 * 60 * 1000);

    logger.info(
      `[visitReminders] Querying visits scheduled between ${startOfTomorrowUtc.toISOString()} and ${endOfTomorrowUtc.toISOString()}`,
    );

    const upcomingVisits = await prisma.siteVisitBooking.findMany({
      where: {
        scheduled_date: {
          gte: startOfTomorrowUtc,
          lte: endOfTomorrowUtc,
        },
        status: {
          in: ['PENDING_ACCEPTANCE', 'ACCEPTED', 'CONFIRMED'],
        },
      },
      include: {
        telecaller: true,
      },
    });

    if (upcomingVisits.length === 0) {
      logger.info('[visitReminders] No open site visits scheduled for tomorrow.');
      return;
    }

    logger.info(`[visitReminders] Found ${upcomingVisits.length} visits to send reminders for.`);

    for (const visit of upcomingVisits) {
      if (visit.telecaller_id) {
        await prisma.notification.create({
          data: {
            employee_id: visit.telecaller_id,
            type: 'SYSTEM_ALERT', // Or a custom type if desired
            title: 'Visit Reconfirmation Reminder',
            message: `Site visit ${visit.booking_code} is scheduled for tomorrow. Please contact the customer to reconfirm.`,
          },
        });
      }

      // Optionally notify the PM as well if one is assigned
      if (visit.project_manager_id) {
        await prisma.notification.create({
          data: {
            employee_id: visit.project_manager_id,
            type: 'SYSTEM_ALERT',
            title: 'Upcoming Visit Reminder',
            message: `Site visit ${visit.booking_code} is scheduled for tomorrow. The telecaller has been reminded to reconfirm.`,
          },
        });
      }
    }

    logger.info('[visitReminders] Successfully sent T-1 visit reminders.');
  } catch (error) {
    logger.error('[visitReminders] Failed to run reminder sweep:', error);
  }
};
