"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpportunityWorkflow = void 0;
/**
 * Phase 8 Packet 4D — Opportunity Workflow with Business Invariants
 *
 * Stage integrity rules enforce minimum real-estate business invariants.
 * The entity passed to canTransition must include the Opportunity record
 * and its relations (site_visits, etc.) for contextual validation.
 *
 * BOOKED is deliberately removed from the public transition graph.
 * Only internal Phase 9 Booking logic may confirm BOOKED.
 */
class OpportunityWorkflow {
    validTransitions = {
        'PROSPECT_QUALIFIED': [
            'REQUIREMENT_CAPTURED',
            'PROPERTY_SHORTLISTED',
            'SITE_VISIT_PLANNED',
            'DROPPED'
        ],
        'REQUIREMENT_CAPTURED': [
            'PROPERTY_SHORTLISTED',
            'SITE_VISIT_PLANNED',
            'DROPPED'
        ],
        'PROPERTY_SHORTLISTED': [
            'SITE_VISIT_PLANNED',
            'SITE_VISIT_COMPLETED',
            'PROPERTY_INTEREST_CONFIRMED',
            'NEGOTIATION',
            'DROPPED'
        ],
        'SITE_VISIT_PLANNED': [
            'SITE_VISIT_COMPLETED',
            'DROPPED'
        ],
        'SITE_VISIT_COMPLETED': [
            'PROPERTY_INTEREST_CONFIRMED',
            'NEGOTIATION',
            'DROPPED'
        ],
        'PROPERTY_INTEREST_CONFIRMED': [
            'NEGOTIATION',
            'BOOKING_INITIATED',
            'DROPPED'
        ],
        'NEGOTIATION': [
            'BOOKING_INITIATED',
            'DROPPED'
        ],
        'BOOKING_INITIATED': [
            'DROPPED'
            // BOOKED is NOT reachable from the public API. Phase 9 only.
        ],
        'BOOKED': [], // Terminal
        'DROPPED': [] // Terminal
    };
    canTransition(req) {
        const { currentState, action: requestedState, entity } = req;
        // BOOKED must never be reachable from the public Phase 8 API
        if (requestedState === 'BOOKED') {
            return {
                allowed: false,
                reason: 'BOOKED stage can only be set by the Phase 9 Booking system'
            };
        }
        // Validate the target state is a valid transition from the current state
        const allowedTargets = this.validTransitions[currentState];
        if (!allowedTargets) {
            return { allowed: false, reason: `Unknown current state: ${currentState}` };
        }
        if (!allowedTargets.includes(requestedState)) {
            return {
                allowed: false,
                reason: `Cannot transition from ${currentState} to ${requestedState}`
            };
        }
        // --- Business Invariant Enforcement ---
        // DROPPED requires drop_reason
        if (requestedState === 'DROPPED') {
            if (!entity || !entity.drop_reason || entity.drop_reason.trim() === '') {
                return {
                    allowed: false,
                    reason: 'Transition to DROPPED requires a non-empty drop_reason'
                };
            }
        }
        // PROPERTY_SHORTLISTED requires project or property context
        if (requestedState === 'PROPERTY_SHORTLISTED') {
            if (!entity?.project_id && !entity?.property_id) {
                return {
                    allowed: false,
                    reason: 'PROPERTY_SHORTLISTED requires a project or property to be associated'
                };
            }
        }
        // SITE_VISIT_PLANNED requires at least one linked SiteVisitBooking
        if (requestedState === 'SITE_VISIT_PLANNED') {
            const visits = entity?.site_visits || [];
            if (visits.length === 0) {
                return {
                    allowed: false,
                    reason: 'SITE_VISIT_PLANNED requires at least one linked SiteVisitBooking'
                };
            }
        }
        // SITE_VISIT_COMPLETED requires at least one SiteVisitBooking with COMPLETED status
        if (requestedState === 'SITE_VISIT_COMPLETED') {
            const visits = entity?.site_visits || [];
            const hasCompleted = visits.some((v) => v.status === 'COMPLETED');
            if (!hasCompleted) {
                return {
                    allowed: false,
                    reason: 'SITE_VISIT_COMPLETED requires at least one SiteVisitBooking with COMPLETED status'
                };
            }
        }
        // PROPERTY_INTEREST_CONFIRMED requires a definitive property target
        if (requestedState === 'PROPERTY_INTEREST_CONFIRMED') {
            if (!entity?.property_id) {
                return {
                    allowed: false,
                    reason: 'PROPERTY_INTEREST_CONFIRMED requires a definitive property/inventory target'
                };
            }
        }
        // NEGOTIATION requires sufficient commercial context
        if (requestedState === 'NEGOTIATION') {
            if (!entity?.expected_value && entity?.expected_value !== 0) {
                return {
                    allowed: false,
                    reason: 'NEGOTIATION requires expected_value (commercial deal context)'
                };
            }
        }
        // BOOKING_INITIATED requires property target and expected value
        if (requestedState === 'BOOKING_INITIATED') {
            if (!entity?.property_id) {
                return {
                    allowed: false,
                    reason: 'BOOKING_INITIATED requires a definitive property/inventory target'
                };
            }
            if (!entity?.expected_value && entity?.expected_value !== 0) {
                return {
                    allowed: false,
                    reason: 'BOOKING_INITIATED requires expected_value (booking handoff information)'
                };
            }
        }
        return { allowed: true, nextState: requestedState };
    }
}
exports.OpportunityWorkflow = OpportunityWorkflow;
