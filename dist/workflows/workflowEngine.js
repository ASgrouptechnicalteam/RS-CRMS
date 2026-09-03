"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WorkflowEngine = void 0;
const types_1 = require("./types");
const lead_workflow_1 = require("./lead.workflow");
const property_workflow_1 = require("./property.workflow");
const siteVisit_workflow_1 = require("./siteVisit.workflow");
class WorkflowEngine {
    /**
     * Central entrypoint for all workflow transitions.
     * Delegates to the appropriate domain workflow for validation.
     * Does NOT perform authorization (that remains in the service layer via can()).
     */
    static canTransition(req) {
        const workflow = this.registry[req.domain];
        if (!workflow) {
            return {
                allowed: false,
                reason: `No workflow registered for domain ${req.domain}`
            };
        }
        return workflow.canTransition(req);
    }
    /**
     * Executes a state transition by first validating via canTransition.
     * If valid, it writes the new state to the database using the provided transaction.
     * Throws an error (with status 409) if the transition is invalid.
     */
    static async transition(tx, leadId, toStatus, context, extraUpdateData = {}) {
        const transitionRes = this.canTransition({
            domain: types_1.WorkflowDomain.LEAD,
            currentState: context.entity.status,
            action: toStatus,
            actor: context.actor,
            entity: context.entity,
        });
        if (!transitionRes.allowed) {
            const error = new Error(transitionRes.reason || 'Invalid state transition');
            error.statusCode = 409;
            throw error;
        }
        return await tx.lead.update({
            where: { id: leadId },
            data: {
                status: transitionRes.nextState || toStatus,
                ...extraUpdateData,
            },
        });
    }
}
exports.WorkflowEngine = WorkflowEngine;
WorkflowEngine.registry = {
    [types_1.WorkflowDomain.LEAD]: new lead_workflow_1.LeadWorkflow(),
    [types_1.WorkflowDomain.PROPERTY]: new property_workflow_1.PropertyWorkflow(),
    [types_1.WorkflowDomain.SITE_VISIT]: new siteVisit_workflow_1.SiteVisitWorkflow(),
};
