import { prisma } from '../lib/prisma';
import { PrismaClient, Lead, Prisma } from '@prisma/client';
import { TokenPayload } from '../utils/jwt';
import { Roles } from '../shared';
import { can } from '../authz/authorization';
import { Permissions } from '../shared';
import { WorkflowEngine } from '../workflows/workflowEngine';
import { WorkflowDomain } from '../workflows/types';
import { OpportunityService } from './opportunity.service';
import { CustomerPortalService } from './customerPortal.service';
import { findBestAssigneeForLead } from '../utils/distributionService';
import { MessageTemplateService } from '../services/messageTemplate.service';
import { buildLeadScope } from '../authz/dataScope';
import { LeadPolicy } from '../policies/lead.policy';

const p = prisma;

export class AppError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
    this.name = 'AppError';
  }
}

export class LeadService {
  /**
   * Helper to generate sequential static lead code: RRH-LD-YYYY-XXXX
   */
  private static async generateNextLeadCode(): Promise<string> {
    const currentYear = new Date().getFullYear();
    const count = await p.lead.count();
    const sequentialNum = (count + 1).toString().padStart(4, '0');
    return `RRH-LD-${currentYear}-${sequentialNum}`;
  }

  static async getLeads(user: TokenPayload, take: number = 20, skip: number = 0) {
    const whereCondition = await buildLeadScope(user);

    const leads = await p.lead.findMany({
      where: whereCondition,
      take,
      skip,
      include: {
        assigned_to: { select: { id: true, employee_code: true, full_name: true, phone: true } },
        created_by: { select: { id: true, employee_code: true, full_name: true } },
        activities: {
          orderBy: { created_at: 'desc' },
          take: 5,
          include: { actor: { select: { id: true, employee_code: true, full_name: true } } },
        },
      },
      orderBy: { created_at: 'desc' },
    });

    return leads.map(lead => ({
      ...lead,
      can_edit: LeadPolicy.canMutate(user, lead)
    }));
  }

  static async getLeadById(user: TokenPayload, leadId: number) {
    const lead = await p.lead.findFirst({
      where: { id: leadId, company_id: user.companyId }
    });
    if (!lead || lead.company_id !== user.companyId) {
      return null;
    }
    return {
      ...lead,
      can_edit: LeadPolicy.canMutate(user, lead)
    };
  }

  static async getDistributionMonitor(companyId: number) {
    const telecallers = await p.employee.findMany({
      where: {
        company_id: companyId,
        status: 'ACTIVE',
        roles: {
          some: { role: { name: Roles.TELECALLER } },
        },
      },
      select: { id: true, employee_code: true, full_name: true, department: true },
    });

    // Instead of N+1 queries, use grouping
    const activeLeadCounts = await p.lead.groupBy({
      by: ['assigned_to_id'],
      where: {
        company_id: companyId,
        assigned_to_id: { in: telecallers.map((t: any) => t.id) },
        status: { in: ['NEW', 'ASSIGNED', 'CONTACTED', 'QUALIFICATION_PENDING', 'QUALIFIED', 'DEMO_SCHEDULED', 'DEMO_COMPLETED', 'SITE_VISIT_SCHEDULED', 'SITE_VISIT_COMPLETED', 'NEGOTIATION', 'BOOKING_INITIATED'] },
      },
      _count: { _all: true },
    });

    const totalAssignedCounts = await p.lead.groupBy({
      by: ['assigned_to_id'],
      where: { company_id: companyId, assigned_to_id: { in: telecallers.map((t: any) => t.id) } },
      _count: { _all: true },
    });

    const totalWonCounts = await p.lead.groupBy({
      by: ['assigned_to_id'],
      where: { company_id: companyId, status: 'BOOKED', assigned_to_id: { in: telecallers.map((t: any) => t.id) } },
      _count: { _all: true },
    });

    const activeMap = new Map(activeLeadCounts.map((x: any) => [x.assigned_to_id, x._count._all]));
    const assignedMap = new Map(totalAssignedCounts.map((x: any) => [x.assigned_to_id, x._count._all]));
    const wonMap = new Map(totalWonCounts.map((x: any) => [x.assigned_to_id, x._count._all]));

    const monitorData = telecallers.map((emp: any) => {
      const activeLeadCount = Number(activeMap.get(emp.id) || 0);
      const totalAssigned = Number(assignedMap.get(emp.id) || 0);
      const totalWon = Number(wonMap.get(emp.id) || 0);

      return {
        id: emp.id,
        employeeCode: emp.employee_code,
        fullName: emp.full_name || emp.employee_code,
        activeLeadCount,
        totalAssigned,
        totalWon,
        closureRate: totalAssigned > 0 ? ((totalWon / totalAssigned) * 100).toFixed(1) + '%' : '0.0%',
      };
    });

    const totalLeadsCount = await p.lead.count({ where: { company_id: companyId } });
    const unassignedCount = await p.lead.count({
      where: { company_id: companyId, assigned_to_id: null },
    });

    return { totalLeadsCount, unassignedCount, telecallers: monitorData };
  }

  static calculateLeadScore(leadData: any): number {
    let score = 0;
    // Base score based on source
    if (leadData.source === 'WALK_IN' || leadData.source === 'REFERRAL') score += 20;
    else if (leadData.source === 'WEBSITE') score += 10;
    
    // Profile completeness
    if (leadData.email) score += 10;
    if (leadData.budget_min && leadData.budget_max) score += 15;
    if (leadData.preferred_location) score += 10;
    if (leadData.property_type_preference) score += 5;
    
    return score;
  }

  static async createLead(user: TokenPayload, dto: any) {
    // ─────────────────────────────────────────────────────────────────────────
    // LEAD ATTRIBUTION IMMUTABILITY CONTRACT
    //
    // created_by_id  = IMMUTABLE — set once from the authenticated server-side
    //                  user identity. Represents permanent attribution credit.
    //                  The original introducer retains credit regardless of any
    //                  subsequent reassignment, qualification, site visit,
    //                  opportunity creation, conversion, or closure.
    //
    // assigned_to_id = MUTABLE — operational assignment, may change freely via
    //                  reassignLead(). Represents who is currently working the lead.
    //
    // DEFENSIVE STRIP: Although LeadCreateSchema (Zod) already excludes
    // created_by_id, we explicitly delete it here so that even if the schema
    // definition ever changes, no client-supplied value can override attribution.
    // ─────────────────────────────────────────────────────────────────────────
    delete dto.created_by_id;

    // 1. DUPLICATE DETECTION (Same Company Only)
    if (!dto.phone) {
      throw new AppError(400, 'Phone number is required for lead creation.');
    }
    const existingLead = await p.lead.findFirst({
      where: {
        company_id: user.companyId,
        OR: [
          { phone: dto.phone },
          ...(dto.email ? [{ email: dto.email }] : [])
        ]
      }
    });

    if (existingLead) {
      if (existingLead.status === 'DROPPED') {
        // Recover it instead of throwing an error
        return await LeadService.updateLeadStatus(user, existingLead.id, 'RECOVERED_TO_POOL');
      }
      throw new AppError(409, `Duplicate lead detected. Lead ${existingLead.lead_code} already exists with this phone or email.`);
    }

    const leadCode = await this.generateNextLeadCode();
    
    // Channel Partners keep their own leads (bypass auto-distribution)
    const isChannelPartner = user.roles.includes(Roles.CHANNEL_PARTNER_MANAGER);
    let bestAssignee = null;
    let assignedToId = null;
    let assignmentType = null;
    let status = 'NEW';
    
    if (isChannelPartner) {
      assignedToId = user.employeeId;
      assignmentType = 'MANUAL_OVERRIDE';
      status = 'ASSIGNED';
    } else {
      bestAssignee = await findBestAssigneeForLead(user.companyId);
      if (bestAssignee) {
        assignedToId = bestAssignee.employeeId;
        assignmentType = 'PERFORMANCE_WEIGHTED';
        status = 'ASSIGNED';
      }
    }

    // 2. DETERMINISTIC LEAD SCORING
    const leadScore = this.calculateLeadScore(dto);

    // 3. SLA BREACH CONFIGURATION (e.g. 2 hours from creation to first contact)
    const slaBreachAt = new Date(Date.now() + 2 * 60 * 60 * 1000);

    // 4. REFERRAL ATTRIBUTION
    let validReferralEmployeeId = null;
    if (dto.source === 'REFERRAL' && dto.referral_employee_id) {
      const refEmp = await p.employee.findFirst({
        where: { id: dto.referral_employee_id, company_id: user.companyId }
      });
      if (!refEmp) {
        throw new AppError(400, 'Invalid or cross-company referral employee.');
      }
      validReferralEmployeeId = refEmp.id;
    }

    return await p.$transaction(async (tx: import('@prisma/client').Prisma.TransactionClient) => {
      const lead = await tx.lead.create({
        data: {
          lead_code: leadCode,
          company_id: user.companyId,
          branch_id: user.branchId || null,
          customer_name: dto.customer_name,
          phone: dto.phone,
          email: dto.email || null,
          source: dto.source || 'MANUAL_ENTRY',
          status: status,
          assigned_to_id: assignedToId,
          assigned_at: assignedToId ? new Date() : null,
          assignment_type: assignmentType,
          property_type_preference: dto.property_type_preference || null,
          budget_min: dto.budget_min || null,
          budget_max: dto.budget_max || null,
          preferred_location: dto.preferred_location || null,
          notes: dto.notes || null,
          created_by_id: user.employeeId,
          campaign: dto.campaign || null,
          utm_source: dto.utm_source || null,
          utm_medium: dto.utm_medium || null,
          utm_campaign: dto.utm_campaign || null,
          lead_score: leadScore,
          sla_breach_at: slaBreachAt,
          referral_person_name: dto.source === 'REFERRAL' ? (dto.referral_person_name || null) : null,
          referral_employee_id: validReferralEmployeeId,
        },
      });

      await tx.leadActivity.create({
        data: {
          lead_id: lead.id,
          actor_id: user.employeeId,
          activity_type: 'LEAD_CREATED',
          notes: `Lead ${lead.lead_code} registered via ${lead.source}`,
        },
      });

      if (bestAssignee) {
        await tx.leadActivity.create({
          data: {
            lead_id: lead.id,
            actor_id: user.employeeId,
            activity_type: 'ASSIGNED_TO_AGENT',
            notes: `Auto-distributed to ${bestAssignee.name} (${bestAssignee.employeeCode}) [Weight Score: ${bestAssignee.weight.toFixed(1)}]`,
          },
        });

        await tx.notification.create({
          data: {
            employee_id: bestAssignee.employeeId,
            type: 'TARGET_ASSIGNED',
            title: 'New Lead Auto-Assigned',
            message: `New Lead ${lead.customer_name} (${lead.phone}) has been assigned to you.`,
          },
        });
      }

      return { lead, assignedTo: bestAssignee };
    });
  }

  static async bulkUploadLeads(user: TokenPayload, rawLeads: any[]) {
    const results = {
      total_rows: rawLeads.length,
      successful_imports: 0,
      duplicates: 0,
      failed_rows: 0,
      errors: [] as any[],
    };

    // Pre-fetch existing phones and emails to detect duplicates efficiently
    const phones = rawLeads.map(l => l.phone).filter(Boolean);
    const emails = rawLeads.map(l => l.email).filter(Boolean);

    const existingLeads = await p.lead.findMany({
      where: { 
        company_id: user.companyId, 
        OR: [
          ...(phones.length > 0 ? [{ phone: { in: phones } }] : []),
          ...(emails.length > 0 ? [{ email: { in: emails } }] : []),
        ]
      },
      select: { id: true, phone: true, email: true, status: true }
    });
    
    const existingPhonesMap = new Map();
    const existingEmailsMap = new Map();
    for (const e of existingLeads) {
      if (e.phone) existingPhonesMap.set(e.phone, e);
      if (e.email) existingEmailsMap.set(e.email, e);
    }

    // Chunking to prevent holding transaction too long
    const CHUNK_SIZE = 50;
    let currentRow = 0;

    for (let i = 0; i < rawLeads.length; i += CHUNK_SIZE) {
      const chunk = rawLeads.slice(i, i + CHUNK_SIZE);

      for (const item of chunk) {
        currentRow++;
        try {
          if (!item.customer_name || !item.phone) {
            results.failed_rows++;
            results.errors.push({ row: currentRow, reason: 'Missing required fields: customer_name or phone' });
            continue;
          }

          const existingLead = existingPhonesMap.get(item.phone) || (item.email ? existingEmailsMap.get(item.email) : undefined);
          if (existingLead) {
            if (existingLead.status === 'DROPPED') {
              await LeadService.updateLeadStatus(user, existingLead.id, 'RECOVERED_TO_POOL');
              results.successful_imports++;
            } else {
              results.duplicates++;
              const duplicateReason = existingPhonesMap.has(item.phone) ? `Duplicate phone number: ${item.phone}` : `Duplicate email: ${item.email}`;
              results.errors.push({ row: currentRow, reason: duplicateReason });
            }
            continue;
          }

          await p.$transaction(async (tx: import('@prisma/client').Prisma.TransactionClient) => {
            const leadCode = await this.generateNextLeadCode(); // Inside transaction to ensure unique code sequentially
            const bestAssignee = await findBestAssigneeForLead(user.companyId);

            const newLead = await tx.lead.create({
              data: {
                lead_code: leadCode,
                company_id: user.companyId,
                branch_id: user.branchId || null,
                customer_name: item.customer_name,
                phone: item.phone,
                email: item.email || null,
                source: item.source || 'BULK_UPLOAD',
                status: bestAssignee ? 'ASSIGNED' : 'NEW',
                assigned_to_id: bestAssignee ? bestAssignee.employeeId : null,
                assigned_at: bestAssignee ? new Date() : null,
                assignment_type: bestAssignee ? 'PERFORMANCE_WEIGHTED' : null,
                property_type_preference: item.property_type || null,
                preferred_location: item.location || null,
                notes: item.notes || 'Imported via Bulk Upload',
                created_by_id: user.employeeId,
                utm_source: item.utm_source || null,
                utm_medium: item.utm_medium || null,
                utm_campaign: item.utm_campaign || null,
              },
            });

            await tx.leadActivity.create({
              data: {
                lead_id: newLead.id,
                actor_id: user.employeeId,
                activity_type: 'LEAD_CREATED',
                notes: `Bulk Upload Lead ${newLead.lead_code} created by Digital Lead Operator`,
              },
            });

            if (bestAssignee) {
              await tx.leadActivity.create({
                data: {
                  lead_id: newLead.id,
                  actor_id: user.employeeId,
                  activity_type: 'ASSIGNED_TO_AGENT',
                  notes: `Weighted Auto-Distribution to ${bestAssignee.name} (${bestAssignee.employeeCode})`,
                },
              });
            }
          });

          // Only add to Map if successfully inserted
          existingPhonesMap.set(item.phone, { id: 0, phone: item.phone, status: 'NEW' });
          if (item.email) {
            existingEmailsMap.set(item.email, { id: 0, email: item.email, status: 'NEW' });
          }
          results.successful_imports++;

        } catch (error: any) {
          results.failed_rows++;
          results.errors.push({ row: currentRow, reason: error.message || 'Database error during insertion' });
        }
      }
    }

    return results;
  }

  static async reassignLead(user: TokenPayload, leadId: number, assigneeId: number, reason: string) {
    const lead = await p.lead.findFirst({ where: { id: leadId, company_id: user.companyId } });
    if (!lead) throw new AppError(404, 'Lead not found');

    if (!can(user, Permissions.LEADS_ASSIGN, lead)) {
      throw new AppError(403, 'Forbidden: Insufficient privileges or cross-company reassignment');
    }

    const assignee = await p.employee.findFirst({ where: { id: assigneeId, company_id: user.companyId } });
    if (!assignee) throw new AppError(404, 'Assignee employee not found');

    return await p.$transaction(async (tx: import('@prisma/client').Prisma.TransactionClient) => {
      const newStatus = lead.status === 'NEW' ? 'ASSIGNED' : lead.status;
      const updated = await WorkflowEngine.transition(
        tx,
        leadId,
        newStatus,
        { actor: user, entity: lead },
        {
          assigned_to_id: assigneeId,
          assigned_at: new Date(),
          assignment_type: 'MANUAL_OVERRIDE',
        }
      );

      await tx.leadActivity.create({
        data: {
          lead_id: leadId,
          actor_id: user.employeeId,
          activity_type: 'ASSIGNED_TO_AGENT',
          notes: `Manual Reassignment to ${assignee.full_name || assignee.employee_code}. Reason: ${reason}`,
        },
      });

      await tx.auditEvent.create({
        data: {
          actor_id: user.employeeId,
          action: 'LEAD_MANUAL_REASSIGNMENT_OVERRIDE',
          entity_type: 'LEAD',
          entity_id: leadId,
          old_value: JSON.stringify({ assigned_to_id: lead.assigned_to_id }),
          new_value: JSON.stringify({ assigned_to_id: assigneeId, reason }),
        },
      });

      return updated;
    });
  }

  static async updateLeadStatus(user: TokenPayload, leadId: number, newStatus: string, notes?: string, guardFields?: { exit_reason?: string; demo_scheduled_at?: string; demo_handler_id?: number; qualification?: any }) {
    const lead = await p.lead.findFirst({ where: { id: leadId, company_id: user.companyId } });
    if (!lead) throw new AppError(404, 'Lead not found');

    if (!can(user, Permissions.LEADS_UPDATE, lead)) {
      throw new AppError(403, 'Forbidden: You do not have permission to mutate this lead');
    }

    // §0: the workflow engine is the ONLY authority allowed to write Lead.status.
    // We assemble the entity context the engine uses for its field-level guards.
    const entityContext: any = {
      ...lead,
      exit_reason: guardFields?.exit_reason ?? lead.exit_reason,
      demo_scheduled_at: guardFields?.demo_scheduled_at ?? lead.demo_scheduled_at,
      demo_handler_id: guardFields?.demo_handler_id ?? lead.demo_handler_id,
    };
    if (guardFields?.demo_scheduled_at) {
      entityContext.demo_scheduled_at = new Date(guardFields.demo_scheduled_at);
    }
    if (guardFields?.qualification) {
      const q = guardFields.qualification;
      if (q.budget_min !== undefined) entityContext.budget_min = q.budget_min;
      if (q.budget_max !== undefined) entityContext.budget_max = q.budget_max;
      if (q.property_type_preference !== undefined) entityContext.property_type_preference = q.property_type_preference;
      if (q.preferred_location !== undefined) entityContext.preferred_location = q.preferred_location;
    }
    // Always pull activities — the CALL_LOGGED guard (§1 row 2) needs them
    entityContext.activities = await p.leadActivity.findMany({ where: { lead_id: leadId } });
    // SITE_VISIT_* guards need the linked visits AND their property outcomes
    if (newStatus === 'SITE_VISIT_SCHEDULED' || newStatus === 'SITE_VISIT_COMPLETED' || newStatus === 'DROPPED') {
      entityContext.site_visits = await p.siteVisitBooking.findMany({ where: { lead_id: leadId } });
      if (newStatus === 'DROPPED') {
        // Pull SiteVisitProperty outcomes for the DROPPED-from-SITE_VISIT_COMPLETED guard
        const visits = entityContext.site_visits;
        const visitIds = visits.map((v: any) => v.id);
        if (visitIds.length > 0) {
          entityContext.site_visit_properties = await p.siteVisitProperty.findMany({
            where: { visit_id: { in: visitIds } },
          });
        }
      }
    }
    // NEGOTIATION / BOOKING_INITIATED guards need the opportunity context
    if (newStatus === 'NEGOTIATION' || newStatus === 'BOOKING_INITIATED') {
      entityContext.opportunities = await p.opportunity.findMany({ where: { lead_id: leadId } });
    }

    // §3: emit a distinct activity_type for each macro-transition
    // (see docs/LEAD-WORKFLOW-SPEC.md §3 for the full registry).
    const activityTypeForTransition = (from: string, to: string): string => {
      if (to === 'DROPPED') return 'LEAD_DROPPED';
      if (to === 'RECOVERED_TO_POOL') return 'LEAD_RECOVERED';
      if (to === 'DEMO_SCHEDULED') return 'DEMO_SCHEDULED';
      if (to === 'DEMO_COMPLETED') return 'DEMO_COMPLETED';
      if (to === 'SITE_VISIT_SCHEDULED') return 'SITE_VISIT_REQUESTED';
      if (to === 'SITE_VISIT_COMPLETED') return 'SITE_VISIT_COMPLETED';
      if (to === 'NEGOTIATION') return 'STATUS_CHANGED'; // Opportunity auto-created (§4) below
      if (to === 'BOOKING_INITIATED') return 'STATUS_CHANGED'; // portal provision stub (§6) below
      if (to === 'BOOKED') return 'STATUS_CHANGED';
      if (from === 'NEW' && to === 'ASSIGNED') return 'ASSIGNED_TO_AGENT';
      return 'STATUS_CHANGED';
    };

    const isDrop = newStatus === 'DROPPED';

    return await p.$transaction(async (tx: import('@prisma/client').Prisma.TransactionClient) => {
      const updateData: any = {
        last_contacted_at: new Date(),
      };
      if (isDrop) {
        updateData.exit_reason = guardFields?.exit_reason || null;
        updateData.exited_from_status = lead.status; // snapshot per §1
      }
      // Persist demo fields when entering DEMO_SCHEDULED
      if (newStatus === 'DEMO_SCHEDULED' && guardFields) {
        if (guardFields.demo_scheduled_at) updateData.demo_scheduled_at = new Date(guardFields.demo_scheduled_at);
        if (guardFields.demo_handler_id) updateData.demo_handler_id = guardFields.demo_handler_id;
      }
      // Persist qualification fields when entering QUALIFIED
      if (newStatus === 'QUALIFIED' && guardFields?.qualification) {
        const q = guardFields.qualification;
        if (q.budget_min !== undefined) updateData.budget_min = q.budget_min;
        if (q.budget_max !== undefined) updateData.budget_max = q.budget_max;
        if (q.property_type_preference !== undefined) updateData.property_type_preference = q.property_type_preference;
        if (q.preferred_location !== undefined) updateData.preferred_location = q.preferred_location;
      }
      // Persist qualification fields when demo handler revises them on DEMO_COMPLETED (§1 row 4)
      if (newStatus === 'DEMO_COMPLETED' && guardFields?.qualification) {
        const q = guardFields.qualification;
        if (q.budget_min !== undefined) updateData.budget_min = q.budget_min;
        if (q.budget_max !== undefined) updateData.budget_max = q.budget_max;
        if (q.property_type_preference !== undefined) updateData.property_type_preference = q.property_type_preference;
        if (q.preferred_location !== undefined) updateData.preferred_location = q.preferred_location;
      }

      const updated = await WorkflowEngine.transition(
        tx,
        leadId,
        newStatus,
        { actor: user, entity: entityContext },
        updateData
      );

      const activityType = activityTypeForTransition(lead.status, newStatus);
      await tx.leadActivity.create({
        data: {
          lead_id: leadId,
          actor_id: user.employeeId,
          activity_type: activityType,
          notes: isDrop
            ? `Lead dropped from ${lead.status}. Reason: ${guardFields?.exit_reason || 'n/a'}`
            : `Status updated from ${lead.status} to ${newStatus}${notes ? `: ${notes}` : ''}`,
        },
      });

      // §4: auto-create Opportunity when entering NEGOTIATION
      if (newStatus === 'NEGOTIATION') {
        // Find the INTERESTED property outcome that unlocked NEGOTIATION (§1:
        // SITE_VISIT_COMPLETED → NEGOTIATION requires ≥1 INTERESTED property).
        const interested = await tx.siteVisitProperty.findFirst({
          where: { outcome: 'INTERESTED' },
          include: { visit: true },
        });
        const interestedLeadId = interested?.visit?.lead_id;
        if (interestedLeadId && interestedLeadId === leadId) {
          await OpportunityService.createFromLeadTx(tx, lead, user.employeeId || 1, interested.property_id);
        } else {
          await OpportunityService.createFromLeadTx(tx, lead, user.employeeId || 1);
        }
      }

      // §6: customer-portal provisioning stub on successful booking
      if (newStatus === 'BOOKED') {
        await CustomerPortalService.provisionStub(tx, lead, user);
      }

      let finalUpdated = updated;

      // Auto-assign recovered leads
      if (newStatus === 'RECOVERED_TO_POOL') {
        const bestAssignee = await findBestAssigneeForLead(user.companyId);
        if (bestAssignee) {
          finalUpdated = await WorkflowEngine.transition(
            tx,
            leadId,
            'ASSIGNED',
            { actor: user, entity: { ...entityContext, status: 'RECOVERED_TO_POOL' } },
            { 
              assigned_to_id: bestAssignee.employeeId, 
              assigned_at: new Date(), 
              assignment_type: 'PERFORMANCE_WEIGHTED' 
            }
          );
          
          await tx.leadActivity.create({
            data: {
              lead_id: leadId,
              actor_id: user.employeeId || 1,
              activity_type: 'ASSIGNED_TO_AGENT',
              notes: `Auto-distributed to ${bestAssignee.name} (${bestAssignee.employeeCode}) [Weight Score: ${bestAssignee.weight.toFixed(1)}] upon recovery`,
            },
          });
        }
      }

      return finalUpdated;
    });
  }

  static async getMatches(user: TokenPayload, leadId: number) {
    const lead = await p.lead.findFirst({ where: { id: leadId, company_id: user.companyId } });
    if (!lead) throw new AppError(404, 'Lead not found');

    if (!can(user, Permissions.LEADS_READ, lead)) {
      throw new AppError(403, 'Forbidden: You do not have permission to view matches for this lead');
    }

    // Call the matching engine (defined in matchingEngine.ts)
    // Note: To avoid circular imports or redefining the engine here, we imported it at the top.
    // However, findMatchingPropertiesForLead requires leadId.
    const { findMatchingPropertiesForLead } = require('../utils/matchingEngine');
    const matches = await findMatchingPropertiesForLead(leadId);
    return matches;
  }

  static async sendWhatsAppProposal(user: TokenPayload, leadId: number, propertyId: number) {
    const lead = await p.lead.findFirst({
      where: { id: leadId, company_id: user.companyId },
      include: { assigned_to: true },
    });
    if (!lead) throw new AppError(404, 'Lead not found');

    if (!can(user, Permissions.LEADS_UPDATE, lead)) {
      throw new AppError(403, 'Forbidden: You do not have permission to propose properties to this lead');
    }

    const property = await p.property.findFirst({ where: { id: propertyId, company_id: user.companyId } });
    if (!property) throw new AppError(404, 'Property not found');

    const company = await p.company.findFirst({ where: { id: user.companyId } });

    // §5: resolve WhatsApp body from the MessageTemplate table (template_key
    // LEAD_PROPERTY_PROPOSAL), never from a hardcoded inline string. Falls back to
    // a safe situation-specific text containing the variables when no active template is configured.
    const templateKey = 'LEAD_PROPERTY_PROPOSAL';
    
    const formattedPrice = property.price ? `${(property.price / 100000).toFixed(1)} Lakhs` : 'On Request';
    
    const resolved = await MessageTemplateService.resolveWithFallback(templateKey, {
      customer_name: lead.customer_name ?? '',
      customer_phone: lead.phone ?? '',
      property_name: property.title ?? '',
      property_location: property.location ?? '',
      property_price: formattedPrice,
      property_code: property.property_code ?? '',
      pm_name: property.assigned_pm_id ? (await p.employee.findFirst({ where: { id: property.assigned_pm_id } }))?.full_name ?? 'Property Manager' : 'Property Manager',
      agent_name: lead.assigned_to?.full_name ?? lead.assigned_to?.employee_code ?? 'Advisory Desk',
      visit_date: new Date().toLocaleDateString('en-IN', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      }),
      lead_code: lead.lead_code ?? '',
      company_name: company?.name ?? 'Our Company',
    });

    const text = resolved.body_text;

    const cleanPhone = lead.phone.replace(/[^0-9]/g, '');
    const whatsAppUrl = `https://wa.me/${cleanPhone.startsWith('91') ? cleanPhone : '91' + cleanPhone}?text=${encodeURIComponent(text)}`;

    // §3: emit WHATSAPP_SENT with the template key embedded in notes
    // (the spec §3 registry item: "WHATSAPP_SENT (with which template key)").
    const activityNotes = `WhatsApp proposal sent using template ${templateKey} for Property ${property.property_code} (${property.title})`;

    await p.leadActivity.create({
      data: {
        lead_id: leadId,
        actor_id: user.employeeId || 1,
        activity_type: 'WHATSAPP_SENT',
        notes: activityNotes,
      },
    });

    return { whatsAppUrl, whatsAppText: text, templateKey };
  }

  static async addPropertyInterest(user: TokenPayload, leadId: number, propertyId: number) {
    const lead = await p.lead.findFirst({ where: { id: leadId, company_id: user.companyId } });
    if (!lead) throw new AppError(404, 'Lead not found');

    if (!can(user, Permissions.LEADS_UPDATE, lead)) {
      throw new AppError(403, 'Forbidden: You do not have permission to modify this lead');
    }

    const property = await p.property.findFirst({ where: { id: propertyId, company_id: user.companyId } });
    if (!property) throw new AppError(404, 'Property not found');

    if (lead.company_id !== property.company_id) {
      throw new AppError(400, 'Invalid relation: Lead and Property belong to different companies');
    }

    return await p.$transaction(async (tx: import('@prisma/client').Prisma.TransactionClient) => {
      const interest = await tx.leadPropertyInterest.upsert({
        where: {
          lead_id_property_id: {
            lead_id: leadId,
            property_id: propertyId,
          }
        },
        update: { is_active: true },
        create: {
          lead_id: leadId,
          property_id: propertyId,
          created_by: user.employeeId || 1,
        }
      });

      await tx.leadActivity.create({
        data: {
          lead_id: leadId,
          actor_id: user.employeeId || 1,
          activity_type: 'PROPERTY_INTEREST_ADDED',
          notes: `Added interest in Property ${property.property_code} (${property.title})`,
        }
      });

      return interest;
    });
  }

  static async removePropertyInterest(user: TokenPayload, leadId: number, propertyId: number) {
    const lead = await p.lead.findFirst({ where: { id: leadId, company_id: user.companyId } });
    if (!lead) throw new AppError(404, 'Lead not found');

    if (!can(user, Permissions.LEADS_UPDATE, lead)) {
      throw new AppError(403, 'Forbidden: You do not have permission to modify this lead');
    }

    const interest = await p.leadPropertyInterest.findUnique({
      where: { lead_id_property_id: { lead_id: leadId, property_id: propertyId } },
      include: { property: true }
    });

    if (!interest) {
      throw new AppError(404, 'Property interest not found');
    }

    return await p.$transaction(async (tx: import('@prisma/client').Prisma.TransactionClient) => {
      await tx.leadPropertyInterest.update({
        where: { id: interest.id },
        data: { is_active: false }
      });

      await tx.leadActivity.create({
        data: {
          lead_id: leadId,
          actor_id: user.employeeId || 1,
          activity_type: 'PROPERTY_INTEREST_REMOVED',
          notes: `Removed interest in Property ${interest.property.property_code} (${interest.property.title})`,
        }
      });

      return { success: true, message: 'Property interest removed successfully' };
    });
  }

  static async getPropertyInterests(user: TokenPayload, leadId: number) {
    const lead = await p.lead.findFirst({ where: { id: leadId, company_id: user.companyId } });
    if (!lead) throw new AppError(404, 'Lead not found');

    if (!can(user, Permissions.LEADS_READ, lead)) {
      throw new AppError(403, 'Forbidden: You do not have permission to read this lead');
    }

    const interests = await p.leadPropertyInterest.findMany({
      where: { lead_id: leadId, is_active: true },
      include: {
        property: {
          select: {
            id: true,
            property_code: true,
            title: true,
            location: true,
            price: true,
            status: true,
            assigned_pm: { select: { id: true, full_name: true } }
          }
        },
        creator: { select: { id: true, full_name: true } }
      },
      orderBy: { created_at: 'desc' }
    });

    return interests;
  }

  static async getLeadTasks(user: TokenPayload, leadId: number) {
    const lead = await p.lead.findFirst({ where: { id: leadId, company_id: user.companyId } });
    if (!lead) throw new AppError(404, 'Lead not found');

    if (!can(user, Permissions.LEADS_READ, lead)) {
      throw new AppError(403, 'Forbidden: You do not have permission to read this lead');
    }

    const tasks = await p.task.findMany({
      where: { lead_id: leadId },
      include: { assignee: { select: { id: true, full_name: true, employee_code: true } } },
      orderBy: [{ target_date: 'asc' }],
    });

    return tasks;
  }
}
