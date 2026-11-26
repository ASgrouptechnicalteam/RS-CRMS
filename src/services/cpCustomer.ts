/**
 * A channel partner's customer as the partner's screens show it (inbox design, 2026-11-26): which of the six steps
 * they are on, how interested they are, and what a call changes. The call results and reasons are the CRM's own.
 */
import {
  CALL_REASONS_BY_OUTCOME,
  CALL_REASON_EXIT_REASON,
  CallReasonType,
  DO_NOT_CALL_EXIT_REASONS,
  DO_NOT_CALL_REASONS,
  DROPPABLE_CALL_OUTCOMES,
  LeadExitReasonType,
} from '../shared';

export const CP_INTEREST = ['HOT', 'WARM', 'COLD'] as const;
export type CpInterest = (typeof CP_INTEREST)[number];

export type CpStep =
  'NEW' | 'CALLED' | 'NEED_KNOWN' | 'SITE_VISIT' | 'PRICE_TALK' | 'BOOKED' | 'CLOSED';

/** The step shown to the partner. Price talk and Booked follow our own CRM once a visit has been booked there. */
export function stepOf(status: string, crmStatus?: string | null): CpStep {
  if (status === 'DROPPED' || status === 'NOT_INTERESTED') return 'CLOSED';
  if (crmStatus === 'BOOKED' || crmStatus === 'BOOKING_INITIATED') return 'BOOKED';
  if (crmStatus === 'NEGOTIATION') return 'PRICE_TALK';
  if (crmStatus === 'DROPPED') return 'CLOSED';
  if (status === 'VISIT_BOOKED') return 'SITE_VISIT';
  if (status === 'INTERESTED') return 'NEED_KNOWN';
  return status === 'CONTACTED' ? 'CALLED' : 'NEW';
}

/** A site visit's result, in the same three words as after a call. */
export const interestOfRating = (rating?: string | null): CpInterest | null =>
  rating === 'HOT_INTERESTED'
    ? 'HOT'
    : rating === 'WARM'
      ? 'WARM'
      : rating === 'COLD' || rating === 'NOT_INTERESTED'
        ? 'COLD'
        : null;

/** Nobody may call this customer again. */
export const isDoNotCall = (exitReason?: string | null) =>
  !!exitReason && DO_NOT_CALL_EXIT_REASONS.includes(exitReason as LeadExitReasonType);

export const CP_CALL_OUTCOMES = [
  'CONNECTED_INTERESTED',
  'CONNECTED_NOT_INTERESTED',
  'CALL_BACK',
  'NO_ANSWER',
  'BUSY_OR_SWITCHED_OFF',
  'BUSY', // the older app
  'WRONG_NUMBER',
] as const;
export type CpCallOutcome = (typeof CP_CALL_OUTCOMES)[number];

/** What the older app's calls do (it sends no reason and no "close this customer" answer). */
const OLDER_APP: Record<CpCallOutcome, string> = {
  CONNECTED_INTERESTED: 'INTERESTED',
  CONNECTED_NOT_INTERESTED: 'NOT_INTERESTED',
  CALL_BACK: 'CONTACTED',
  NO_ANSWER: 'CONTACTED',
  BUSY_OR_SWITCHED_OFF: 'CONTACTED',
  BUSY: 'CONTACTED',
  WRONG_NUMBER: 'DROPPED',
};

export interface CallEffect {
  status: string;
  closes: boolean;
  doNotCall: boolean;
  exit_reason: LeadExitReasonType | null;
}

/** What one call does to the customer. Throws a plain message when the answers do not fit together. */
export function callEffect(
  current: string,
  call: { outcome: CpCallOutcome; reason?: string | null; drop_lead?: boolean },
): CallEffect {
  const reason = (call.reason || undefined) as CallReasonType | undefined;
  if (reason && !(CALL_REASONS_BY_OUTCOME[call.outcome] || []).includes(reason)) {
    throw { status: 400, message: 'That reason does not fit this call result.' };
  }
  const doNotCall = !!reason && DO_NOT_CALL_REASONS.includes(reason);
  const closes = doNotCall || (!!call.drop_lead && DROPPABLE_CALL_OUTCOMES.includes(call.outcome));
  if (closes) {
    return {
      status: 'DROPPED',
      closes: true,
      doNotCall,
      exit_reason: reason ? CALL_REASON_EXIT_REASON[reason].exit_reason : 'OTHER',
    };
  }
  const older = call.drop_lead === undefined && !reason;
  let status = OLDER_APP[call.outcome];
  if (!older) {
    // Not reaching a customer, or keeping one for later, never loses what is already known.
    status =
      call.outcome === 'CONNECTED_INTERESTED'
        ? 'INTERESTED'
        : current === 'INTERESTED' && call.outcome !== 'CONNECTED_NOT_INTERESTED'
          ? 'INTERESTED'
          : 'CONTACTED';
  }
  // A visit that is booked stays booked unless the customer drops out.
  if (current === 'VISIT_BOOKED' && status !== 'DROPPED' && status !== 'NOT_INTERESTED') {
    status = 'VISIT_BOOKED';
  }
  return { status, closes: status === 'DROPPED', doNotCall: false, exit_reason: null };
}
