import { WorkflowDomain, WorkflowTransitionRequest, WorkflowTransitionResult, DomainWorkflow } from './types';
import { LeadWorkflow } from './lead.workflow';
import { PropertyWorkflow } from './property.workflow';
import { SiteVisitWorkflow } from './siteVisit.workflow';

export class WorkflowEngine {
  private static registry: Record<WorkflowDomain, DomainWorkflow> = {
    [WorkflowDomain.LEAD]: new LeadWorkflow(),
    [WorkflowDomain.PROPERTY]: new PropertyWorkflow(),
    [WorkflowDomain.SITE_VISIT]: new SiteVisitWorkflow(),
  };

  /**
   * Central entrypoint for all workflow transitions.
   * Delegates to the appropriate domain workflow for validation.
   * Does NOT perform authorization (that remains in the service layer via can()).
   */
  static canTransition(req: WorkflowTransitionRequest): WorkflowTransitionResult {
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
  static async transition(
    tx: import('@prisma/client').Prisma.TransactionClient,
    leadId: number,
    toStatus: string,
    context: { actor: import('../utils/jwt').TokenPayload; entity: any },
    extraUpdateData: any = {}
  ) {
    const transitionRes = this.canTransition({
      domain: WorkflowDomain.LEAD,
      currentState: context.entity.status,
      action: toStatus,
      actor: context.actor,
      entity: context.entity,
    });

    if (!transitionRes.allowed) {
      const error = new Error(transitionRes.reason || 'Invalid state transition');
      (error as any).statusCode = 409;
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
