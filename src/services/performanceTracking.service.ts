import { prisma } from '../lib/prisma';
import { TokenPayload } from '../utils/jwt';

const p = prisma;

export class PerformanceTrackingService {
  
  static async getTelecallerMetrics(user: TokenPayload, startDate: Date, endDate: Date, telecallerId?: number) {
    const targetUserId = telecallerId || user.employeeId;

    // 1. Contact Rate
    // Leads Contacted or beyond / Total assigned to this telecaller in the period
    const totalAssigned = await p.lead.count({
      where: {
        assigned_to_id: targetUserId,
        created_at: { gte: startDate, lte: endDate },
      }
    });

    const contactedOrBeyond = await p.lead.count({
      where: {
        assigned_to_id: targetUserId,
        created_at: { gte: startDate, lte: endDate },
        status: { notIn: ['NEW', 'ASSIGNED', 'DROPPED'] } // Anything that has moved past ASSIGNED
      }
    });

    // 2. Qualification Rate
    const qualifiedOrBeyond = await p.lead.count({
      where: {
        assigned_to_id: targetUserId,
        created_at: { gte: startDate, lte: endDate },
        status: { notIn: ['NEW', 'ASSIGNED', 'CONTACTED', 'DROPPED'] } // Anything moved past CONTACTED
      }
    });

    // 3. Demos Booked
    const demosBooked = await p.lead.count({
      where: {
        assigned_to_id: targetUserId,
        created_at: { gte: startDate, lte: endDate },
        status: { in: ['DEMO_SCHEDULED', 'DEMO_COMPLETED', 'SITE_VISIT_SCHEDULED', 'SITE_VISIT_COMPLETED', 'NEGOTIATION', 'BOOKING_INITIATED', 'BOOKED'] }
      }
    });

    // 4. Site Visits Completed
    const siteVisitsCompleted = await p.siteVisitBooking.count({
      where: {
        telecaller_id: targetUserId,
        completed_at: { gte: startDate, lte: endDate },
        status: 'COMPLETED'
      }
    });

    // 5. Bookings Closed
    const bookingsClosed = await p.lead.count({
      where: {
        assigned_to_id: targetUserId,
        updated_at: { gte: startDate, lte: endDate },
        status: 'BOOKED'
      }
    });

    // 6. Reconfirmation Completion Rate
    // Numerator: site visits reaching CONFIRMED status
    // Denominator: site visits that EVER reached PENDING_CUSTOMER_RECONFIRMATION
    const reconfirmationEvents = await p.auditEvent.findMany({
      where: {
        entity_type: 'SITE_VISIT',
        new_value: { contains: 'PENDING_CUSTOMER_RECONFIRMATION' },
        created_at: { gte: startDate, lte: endDate }
      },
      select: { entity_id: true }
    });
    const reconfirmationAttemptedVisitIds = [...new Set(reconfirmationEvents.map(e => e.entity_id))];
    
    let reconfirmationsCompleted = 0;
    if (reconfirmationAttemptedVisitIds.length > 0) {
      const confirmedVisits = await p.auditEvent.findMany({
        where: {
          entity_type: 'SITE_VISIT',
          entity_id: { in: reconfirmationAttemptedVisitIds },
          new_value: { contains: 'CONFIRMED' }
        },
        select: { entity_id: true }
      });
      reconfirmationsCompleted = new Set(confirmedVisits.map(e => e.entity_id)).size;
    }

    return {
      totalAssigned,
      contactedOrBeyond,
      contactRate: totalAssigned > 0 ? contactedOrBeyond / totalAssigned : 0,
      qualifiedOrBeyond,
      qualificationRate: contactedOrBeyond > 0 ? qualifiedOrBeyond / contactedOrBeyond : 0,
      demosBooked,
      siteVisitsCompleted,
      bookingsClosed,
      reconfirmationsAttempted: reconfirmationAttemptedVisitIds.length,
      reconfirmationsCompleted,
      reconfirmationCompletionRate: reconfirmationAttemptedVisitIds.length > 0 ? reconfirmationsCompleted / reconfirmationAttemptedVisitIds.length : 0
    };
  }

  static async getPmMetrics(user: TokenPayload, startDate: Date, endDate: Date, pmId?: number) {
    const targetUserId = pmId || user.employeeId;

    // 1. Requests Approved/Reassigned
    const requestsHandled = await p.siteVisitBooking.count({
      where: {
        project_manager_id: targetUserId,
        created_at: { gte: startDate, lte: endDate },
        status: { in: ['ACCEPTED', 'REASSIGNED', 'PENDING_CUSTOMER_RECONFIRMATION', 'PENDING_PM_RECONFIRMATION', 'CONFIRMED', 'ACTIVE', 'COMPLETED'] }
      }
    });

    // 2. Average Response Time
    const bookings = await p.siteVisitBooking.findMany({
      where: {
        project_manager_id: targetUserId,
        created_at: { gte: startDate, lte: endDate }
      },
      select: {
        id: true,
        created_at: true,
        escalation: true
      }
    });

    let totalResponseTimeMs = 0;
    let responseCount = 0;
    let escalatedWithoutResponseCount = 0;

    for (const b of bookings) {
      let escalationTime: Date | null = null;
      if (b.escalation && b.escalation.marketing_director_notified_at) {
        escalationTime = b.escalation.marketing_director_notified_at;
      }
      
      const firstResponse = await p.auditEvent.findFirst({
        where: {
          entity_type: 'SITE_VISIT',
          entity_id: b.id,
          action: 'STATUS_CHANGED',
          OR: [
            { new_value: { contains: 'ACCEPTED' } },
            { new_value: { contains: 'REASSIGNED' } }
          ]
        },
        orderBy: { created_at: 'asc' }
      });

      if (escalationTime) {
        if (firstResponse && firstResponse.created_at < escalationTime) {
          totalResponseTimeMs += (firstResponse.created_at.getTime() - b.created_at.getTime());
          responseCount++;
        } else {
          escalatedWithoutResponseCount++;
        }
      } else {
        if (firstResponse) {
          totalResponseTimeMs += (firstResponse.created_at.getTime() - b.created_at.getTime());
          responseCount++;
        }
      }
    }

    const averageResponseTimeMs = responseCount > 0 ? totalResponseTimeMs / responseCount : 0;

    // 3. Visits Completed
    const visitsCompleted = await p.siteVisitBooking.count({
      where: {
        project_manager_id: targetUserId,
        completed_at: { gte: startDate, lte: endDate },
        status: 'COMPLETED'
      }
    });

    return {
      requestsHandled,
      averageResponseTimeMs,
      escalatedWithoutResponseCount,
      visitsCompleted
    };
  }
}
