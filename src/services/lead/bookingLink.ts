/**
 * Which bookings belong to a lead (2026-11-26). A booking is tied to its lead either through the deal
 * (Opportunity.booking_id) or, for a booking made with the booking form, through the customer made from the lead.
 */

/** Bookings that mean the customer has bought. */
const BOUGHT = ['CONFIRMED', 'COMPLETED'];

export async function bookingsForLead(
  db: any,
  leadId: number,
): Promise<{ id: number; status: string }[]> {
  const deals = await db.opportunity.findMany({
    where: { lead_id: leadId, booking_id: { not: null } },
    select: { booking_id: true },
  });
  return db.booking.findMany({
    where: {
      OR: [
        { customer: { origin_lead_id: leadId } },
        { id: { in: deals.map((d: { booking_id: number }) => d.booking_id) } },
      ],
    },
    select: { id: true, status: true },
  });
}

export const hasConfirmedBooking = (bookings: { status: string }[]) =>
  bookings.some((b) => BOUGHT.includes(b.status));
