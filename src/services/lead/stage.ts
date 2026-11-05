import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { TokenPayload } from '../../utils/jwt';
import { AppError } from './errors';
import { CALL_OUTCOMES } from './calls';
import { generateNextBookingCode } from '../siteVisit/shared';
import { OpportunityService } from '../opportunity.service';
import { Roles } from '../../shared';

const p = prisma;

/**
 * Stages a lead can be added at. Real estate does not always follow the steps:
 * customers walk in for a visit or a demo with no call and no qualification, and
 * associates bring customers who are already further along. Booking stages are
 * excluded: those need a real booking with payments and approvals.
 */
export const INITIAL_STAGES = [
  'ASSIGNED',
  'CONTACTED',
  'QUALIFIED',
  'DEMO_SCHEDULED',
  'DEMO_COMPLETED',
  'SITE_VISIT_SCHEDULED',
  'SITE_VISIT_COMPLETED',
  'NEGOTIATION',
] as const;
export type InitialStage = (typeof INITIAL_STAGES)[number];

// A demo handler must be able to run a demo: same roles as moving a lead to a demo.
const DEMO_HANDLER_ROLES: string[] = [
  Roles.PROJECT_MANAGER,
  Roles.AGENT,
  Roles.SALES_MANAGER,
  Roles.CHANNEL_PARTNER_MANAGER,
  Roles.MD,
];
const VISIT_STAGES: InitialStage[] = [
  'SITE_VISIT_SCHEDULED',
  'SITE_VISIT_COMPLETED',
  'NEGOTIATION',
];
const DEMO_STAGES: InitialStage[] = ['DEMO_SCHEDULED', 'DEMO_COMPLETED'];

export interface StageDetails {
  contacted_at?: string;
  call_notes?: string;
  project_id?: number;
  visit_at?: string;
  visit_handled_by_id?: number;
  visit_rating?: 'HOT_INTERESTED' | 'WARM' | 'COLD' | 'NOT_INTERESTED';
  visit_feedback?: string;
  demo_at?: string;
  demo_handled_by_id?: number;
  demo_summary?: string;
  negotiation_notes?: string;
  expected_value?: number;
}

const STAGE_LABEL: Record<InitialStage, string> = {
  ASSIGNED: 'Not contacted yet',
  CONTACTED: 'Contacted',
  QUALIFIED: 'Qualified',
  DEMO_SCHEDULED: 'Demo scheduled',
  DEMO_COMPLETED: 'Demo completed',
  SITE_VISIT_SCHEDULED: 'Site visit scheduled',
  SITE_VISIT_COMPLETED: 'Site visit completed',
  NEGOTIATION: 'Negotiation',
};

const parseDate = (v: string | undefined, label: string) => {
  const d = v ? new Date(v) : null;
  if (!d || Number.isNaN(d.getTime())) throw new AppError(400, `${label} is required`);
  return d;
};

export interface ResolvedStage {
  stage: InitialStage;
  contactedAt?: Date;
  callNotes?: string;
  project?: { id: number; name: string; assigned_pm_id: number | null };
  visitAt?: Date;
  handler?: { id: number; name: string };
  demoAt?: Date;
  demoHandler?: { id: number; name: string };
  details: StageDetails;
}

/**
 * Checks every detail the chosen stage needs is present (the same things
 * the normal step-by-step flow would have collected) before anything is
 * written.
 */
export async function resolveInitialStage(
  user: TokenPayload,
  stage: InitialStage,
  details: StageDetails,
  dto: {
    property_type_preference?: string | null;
    budget_max?: number | null;
    preferred_location?: string | null;
    preferred_locations?: string[];
  },
): Promise<ResolvedStage> {
  const out: ResolvedStage = { stage, details };
  if (stage === 'ASSIGNED') return out;
  const now = Date.now() + 5 * 60 * 1000;

  // A call is on record only if there was one: someone who walks in for a visit
  // or a demo was never called, so these are optional from the demo stages on.
  const needsContact = stage === 'CONTACTED' || stage === 'QUALIFIED';
  if (needsContact || details.contacted_at) {
    out.contactedAt = parseDate(details.contacted_at, 'Date the customer was first spoken to');
    if (out.contactedAt.getTime() > now) {
      throw new AppError(400, 'The first-contact date cannot be in the future');
    }
    out.callNotes = details.call_notes?.trim() || undefined;
  }

  if (stage === 'QUALIFIED') {
    const hasLocation = !!(dto.preferred_locations?.length || dto.preferred_location?.trim());
    if (!dto.property_type_preference || !dto.budget_max || !hasLocation) {
      throw new AppError(400, 'Property type, budget and preferred location are required');
    }
  }

  const isVisit = VISIT_STAGES.includes(stage);
  if (isVisit && !details.project_id) {
    throw new AppError(400, 'Choose the project of the site visit');
  }
  if (details.project_id && (isVisit || DEMO_STAGES.includes(stage))) {
    const project = await p.project.findFirst({
      where: { id: details.project_id, company_id: user.companyId },
      select: { id: true, name: true, assigned_pm_id: true },
    });
    if (!project) throw new AppError(404, 'Project not found');
    out.project = project;
  }

  if (DEMO_STAGES.includes(stage)) {
    if (!details.demo_handled_by_id) throw new AppError(400, 'Choose who handles the demo');
    const handler = await p.employee.findFirst({
      where: {
        id: details.demo_handled_by_id,
        company_id: user.companyId,
        status: 'ACTIVE',
        roles: { some: { role: { name: { in: DEMO_HANDLER_ROLES } } } },
      },
      select: { id: true, full_name: true, employee_code: true },
    });
    if (!handler) {
      throw new AppError(
        400,
        'A demo is handled by a Project Manager, Agent, Sales Manager, Channel Partner Manager or the MD.',
      );
    }
    out.demoHandler = { id: handler.id, name: handler.full_name || handler.employee_code };
    out.demoAt = parseDate(details.demo_at, 'Demo date and time');
    if (stage === 'DEMO_SCHEDULED' && out.demoAt.getTime() < Date.now() - 60 * 60 * 1000) {
      throw new AppError(400, 'A scheduled demo must be in the future');
    }
    if (stage === 'DEMO_COMPLETED') {
      if (out.demoAt.getTime() > now) {
        throw new AppError(400, 'A completed demo cannot be in the future');
      }
      if (!details.demo_summary?.trim()) {
        throw new AppError(400, 'Enter what happened in the demo');
      }
    }
  }

  if (isVisit) {
    if (!details.visit_handled_by_id) {
      throw new AppError(400, 'Choose who handles the site visit');
    }
    const handler = await p.employee.findFirst({
      where: { id: details.visit_handled_by_id, company_id: user.companyId, status: 'ACTIVE' },
      select: { id: true, full_name: true, employee_code: true },
    });
    if (!handler) throw new AppError(404, 'Site visit handler not found');
    out.handler = { id: handler.id, name: handler.full_name || handler.employee_code };

    out.visitAt = parseDate(details.visit_at, 'Site visit date and time');
    if (stage === 'SITE_VISIT_SCHEDULED' && out.visitAt.getTime() < Date.now() - 60 * 60 * 1000) {
      throw new AppError(400, 'A scheduled visit must be in the future');
    }
  }

  if (stage === 'SITE_VISIT_COMPLETED' || stage === 'NEGOTIATION') {
    if (out.visitAt!.getTime() > now) {
      throw new AppError(400, 'A completed visit cannot be in the future');
    }
    if (!details.visit_rating)
      throw new AppError(400, "Choose the customer's interest after the visit");
    if (!details.visit_feedback?.trim()) throw new AppError(400, 'Enter the site visit feedback');
  }

  if (stage === 'NEGOTIATION' && !details.negotiation_notes?.trim()) {
    throw new AppError(400, 'Enter what is being negotiated');
  }
  // Negotiation needs a deal value: without an Opportunity carrying one, the
  // lead could never be moved on to Booking initiated afterwards.
  if (stage === 'NEGOTIATION' && !(Number(details.expected_value) > 0)) {
    throw new AppError(400, 'Enter the expected deal value for the negotiation');
  }
  return out;
}

/** Writes the records the chosen stage implies, inside the lead's create transaction. */
export async function applyInitialStage(
  tx: Prisma.TransactionClient,
  user: TokenPayload,
  lead: {
    id: number;
    customer_name: string;
    lead_code: string;
    company_id: number;
    source?: string | null;
    campaign?: string | null;
    utm_source?: string | null;
    utm_medium?: string | null;
    utm_campaign?: string | null;
    budget_min?: number | null;
    budget_max?: number | null;
  },
  r: ResolvedStage,
) {
  if (r.stage === 'ASSIGNED') return;

  if (r.contactedAt) {
    await tx.leadActivity.create({
      data: {
        lead_id: lead.id,
        actor_id: user.employeeId,
        activity_type: 'CALL_LOGGED',
        notes: `[${CALL_OUTCOMES.CONNECTED_INTERESTED}] ${r.callNotes || 'Spoken to before the lead was added'}`,
        created_at: r.contactedAt,
      },
    });
  }

  if (r.demoHandler) {
    const completed = r.stage === 'DEMO_COMPLETED';
    const summary = r.details.demo_summary?.trim() || 'Demo arranged when the lead was added.';
    // Already agreed with the handler, so it does not wait for their acceptance.
    await tx.demo.create({
      data: {
        lead_id: lead.id,
        handler_id: r.demoHandler.id,
        scheduled_at: r.demoAt!,
        summary,
        status: completed ? 'COMPLETED' : 'PENDING',
        accepted_at: new Date(),
        accepted_by: user.employeeId,
      },
    });
    await tx.leadActivity.create({
      data: {
        lead_id: lead.id,
        actor_id: user.employeeId,
        activity_type: completed ? 'DEMO_COMPLETED' : 'STATUS_CHANGED',
        notes: `Demo${r.project ? ` of ${r.project.name}` : ''} on ${r.demoAt!.toDateString()}, handled by ${r.demoHandler.name}. ${summary}`,
      },
    });
    if (r.demoHandler.id !== user.employeeId) {
      await tx.notification.create({
        data: {
          employee_id: r.demoHandler.id,
          type: 'STATUS_UPDATE',
          title: completed ? 'Demo recorded' : 'Demo scheduled for you',
          message: `${lead.customer_name} (${lead.lead_code}), ${r.demoAt!.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}. Recorded when the lead was added.`,
        },
      });
    }
  }

  if (VISIT_STAGES.includes(r.stage)) {
    const pmId = r.project!.assigned_pm_id;
    const completed = r.stage !== 'SITE_VISIT_SCHEDULED';
    const booking = await tx.siteVisitBooking.create({
      data: {
        booking_code: await generateNextBookingCode(),
        lead_id: lead.id,
        telecaller_id: user.employeeId,
        project_id: r.project!.id,
        project_manager_id: pmId ?? r.handler!.id,
        assigned_agent_id: pmId && pmId !== r.handler!.id ? r.handler!.id : null,
        scheduled_date: r.visitAt!,
        status: completed ? 'COMPLETED' : 'CONFIRMED',
        verification_call_notes: 'Recorded when the lead was added.',
        ...(completed
          ? {
              completed_at: r.visitAt,
              rating: r.details.visit_rating,
              feedback_notes: r.details.visit_feedback!.trim(),
            }
          : {}),
      },
    });
    await tx.leadActivity.create({
      data: {
        lead_id: lead.id,
        actor_id: user.employeeId,
        activity_type: completed ? 'SITE_VISIT_COMPLETED' : 'SITE_VISIT_BOOKED',
        notes: completed
          ? `Visit ${booking.booking_code} to ${r.project!.name} on ${r.visitAt!.toDateString()}, handled by ${r.handler!.name}. Interest: ${r.details.visit_rating}. Feedback: ${r.details.visit_feedback!.trim()}`
          : `Visit ${booking.booking_code} to ${r.project!.name} on ${r.visitAt!.toDateString()}, handled by ${r.handler!.name}`,
      },
    });
    await tx.notification.create({
      data: {
        employee_id: r.handler!.id,
        type: 'STATUS_UPDATE',
        title: completed ? 'Site visit recorded' : 'Site visit scheduled for you',
        message: `${lead.customer_name} (${lead.lead_code}) — ${r.project!.name}, ${r.visitAt!.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}. Recorded when the lead was added.`,
      },
    });
  }

  if (r.stage === 'NEGOTIATION') {
    await tx.leadActivity.create({
      data: {
        lead_id: lead.id,
        actor_id: user.employeeId,
        activity_type: 'NOTE_ADDED',
        notes: `Negotiation: ${r.details.negotiation_notes!.trim()}`,
      },
    });
    // The deal value given here; the unit is chosen later, at Booking initiated.
    await OpportunityService.createFromLeadTx(tx, lead, user.employeeId, null, null, {
      expectedValue: Number(r.details.expected_value),
      projectId: r.project?.id ?? null,
      budgetMin: lead.budget_min ?? null,
      budgetMax: lead.budget_max ?? null,
    });
  }

  await tx.leadActivity.create({
    data: {
      lead_id: lead.id,
      actor_id: user.employeeId,
      activity_type: 'STATUS_CHANGED',
      notes: `Added directly at "${STAGE_LABEL[r.stage]}" (the customer had already reached this stage).`,
    },
  });
}
