/**
 * The one meaning of "deal": a booking the MD has confirmed. Drafts and bookings still
 * waiting for approval are not deals; registration and completion come after confirming.
 */
export const DEAL_STATUSES = ['CONFIRMED', 'REGISTERED', 'COMPLETED'];
