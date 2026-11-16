import { Prisma } from '@prisma/client';
import { TokenPayload } from '../utils/jwt';
import { Roles } from '../shared';
import { prisma } from '../lib/prisma';

/**
 * PM narrowing (owner decision 4, 2026-11-14), behind the switch
 * PM_SCOPE_NARROWING=on|off (default off).
 *
 * When on, a project manager sees a booking, opportunity, payment or customer
 * only when they are linked to it: the PM of its project or property, the PM
 * a site visit of its lead was routed to, or the owner of its lead (or of the
 * record itself). MD, Admin, Finance and the other company-wide roles are not
 * narrowed, and a PM who also holds one of those roles keeps that role's view.
 *
 * None of the four tables has a PM column, so every rule is a join.
 */
export const pmNarrowingOn = (): boolean =>
  (process.env.PM_SCOPE_NARROWING || '').trim().toLowerCase() === 'on';

// Every role that sees these records company-wide today, other than the PM.
const WIDE_ROLES: string[] = [
  Roles.MD,
  Roles.ADMIN,
  Roles.HR_MANAGER,
  Roles.FINANCE,
  Roles.MARKETING_DIRECTOR,
  Roles.DIGITAL_LEAD_OPERATOR,
  Roles.DIGITAL_MARKETING_HEAD,
  Roles.SALES_MANAGER,
  Roles.DATA_ENTRY_OPERATOR,
];

export const isNarrowedPm = (user: TokenPayload): boolean =>
  pmNarrowingOn() &&
  user.roles.includes(Roles.PROJECT_MANAGER) &&
  !user.roles.some((r) => WIDE_ROLES.includes(r));

/** A lead the PM owns, or one whose site visit was routed to them. */
const leadLink = (me: number): Prisma.LeadWhereInput => ({
  OR: [{ assigned_to_id: me }, { site_visits: { some: { project_manager_id: me } } }],
});

export const pmOpportunityWhere = (me: number): Prisma.OpportunityWhereInput => ({
  OR: [
    { owner_id: me },
    { project: { assigned_pm_id: me } },
    { property: { assigned_pm_id: me } },
    { project_unit: { project: { assigned_pm_id: me } } },
    { site_visits: { some: { project_manager_id: me } } },
    { lead: leadLink(me) },
  ],
});

export const pmBookingWhere = (me: number): Prisma.BookingWhereInput => ({
  OR: [
    { assigned_employee_id: me },
    { property: { assigned_pm_id: me } },
    { project_unit: { project: { assigned_pm_id: me } } },
    // A booking has no lead column: it reaches its lead through the
    // opportunity it came from, or through the customer's first lead.
    { opportunity: { OR: [{ owner_id: me }, { lead: leadLink(me) }] } },
    { customer: { origin_lead: leadLink(me) } },
  ],
});

export const pmPaymentWhere = (me: number): Prisma.PaymentWhereInput => ({
  OR: [{ recorded_by_id: me }, { booking: pmBookingWhere(me) }],
});

export const pmCustomerWhere = (me: number): Prisma.CustomerWhereInput => ({
  OR: [
    { assigned_to_id: me },
    { origin_lead: leadLink(me) },
    { bookings: { some: pmBookingWhere(me) } },
  ],
});

/** Extra list filter for the caller: `{}` unless they are a narrowed PM. */
export const pmScope = {
  booking: (user: TokenPayload): Prisma.BookingWhereInput =>
    isNarrowedPm(user) ? pmBookingWhere(user.employeeId) : {},
  opportunity: (user: TokenPayload): Prisma.OpportunityWhereInput =>
    isNarrowedPm(user) ? pmOpportunityWhere(user.employeeId) : {},
  payment: (user: TokenPayload): Prisma.PaymentWhereInput =>
    isNarrowedPm(user) ? pmPaymentWhere(user.employeeId) : {},
  customer: (user: TokenPayload): Prisma.CustomerWhereInput =>
    isNarrowedPm(user) ? pmCustomerWhere(user.employeeId) : {},
};

type Kind = keyof typeof pmScope;

/** Single-record check; true for everyone who is not a narrowed PM. */
export async function pmMaySee(user: TokenPayload, kind: Kind, id: number): Promise<boolean> {
  if (!isNarrowedPm(user)) return true;
  const me = user.employeeId;
  switch (kind) {
    case 'booking':
      return (await prisma.booking.count({ where: { id, ...pmBookingWhere(me) } })) > 0;
    case 'opportunity':
      return (await prisma.opportunity.count({ where: { id, ...pmOpportunityWhere(me) } })) > 0;
    case 'payment':
      return (await prisma.payment.count({ where: { id, ...pmPaymentWhere(me) } })) > 0;
    case 'customer':
      return (await prisma.customer.count({ where: { id, ...pmCustomerWhere(me) } })) > 0;
  }
}
