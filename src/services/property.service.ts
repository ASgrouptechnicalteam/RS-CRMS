import { prisma } from '../lib/prisma';
import { PrismaClient, Property } from '@prisma/client';
import { TokenPayload } from '../utils/jwt';
import { Roles, PropertyAvailabilityType } from '../shared';
import { can } from '../authz/authorization';
import { Permissions } from '../shared';
import { WorkflowEngine } from '../workflows/workflowEngine';
import { WorkflowDomain } from '../workflows/types';
import { PropertyPolicy } from '../policies/property.policy';
import { buildPropertyScope } from '../authz/dataScope';
import { slugify, generateUniqueSlug } from '../utils/slugify';
import { logger } from '../utils/logger';

const p = prisma;

/**
 * Derives the public-facing availability status from internal property state.
 * AVAILABLE: LIVE and no active lock
 * RESERVED: LOCKED with an active (non-expired) lock
 * SOLD: BOOKED or SOLD
 * UNAVAILABLE: PENDING_*, REJECTED, or any other internal state
 *
 * Expired locks resolve to AVAILABLE — the property is effectively free inventory.
 */
export function deriveAvailability(property: { status: string; locked_until: Date | null }): PropertyAvailabilityType {
  if (property.status === 'LIVE') return 'AVAILABLE';
  if (property.status === 'LOCKED') {
    if (property.locked_until && property.locked_until < new Date()) return 'AVAILABLE';
    return 'RESERVED';
  }
  if (property.status === 'BOOKED' || property.status === 'SOLD') return 'SOLD';
  return 'UNAVAILABLE';
}

export class PropertyService {
  private static async generateNextPropertyCode(): Promise<string> {
    const currentYear = new Date().getFullYear();
    const count = await p.property.count();
    const seq = (count + 1).toString().padStart(4, '0');
    return `RRH-PR-${currentYear}-${seq}`;
  }

  static async listProperties(user: TokenPayload, filters: { brand?: string; status?: string; project_id?: number; unassigned?: boolean; dm_executive_id?: number }, take: number = 20, skip: number = 0) {
    const whereCondition = await buildPropertyScope(user);
    
    if (filters.brand) {
      whereCondition.brand_type = filters.brand;
    }
    if (filters.status) {
      whereCondition.status = filters.status;
    }
    if (filters.project_id) {
      whereCondition.project_id = filters.project_id;
    }
    if (filters.unassigned) {
      whereCondition.assigned_pm_id = null;
    }
    if (filters.dm_executive_id) {
      whereCondition.digital_marketing_executive_id = filters.dm_executive_id;
    }

    return await p.property.findMany({
      where: whereCondition,
      take,
      skip,
      include: {
        assigned_pm: { select: { id: true, employee_code: true, full_name: true, phone: true } },
        created_by: { select: { id: true, employee_code: true, full_name: true } },
        images: true,
        verification_logs: {
          orderBy: { created_at: 'desc' },
          include: { actor: { select: { id: true, employee_code: true, full_name: true } } },
        },
        _count: {
          select: { interested_leads: true }
        },
      },
      orderBy: { created_at: 'desc' },
    });
  }

  static async createProperty(user: TokenPayload, data: any) {
    if (!can(user, Permissions.PROPERTIES_CREATE)) {
      throw { status: 403, message: 'Forbidden: Missing properties.create permission' };
    }

    const companyId = user.companyId || 1;
    const branchId = user.branchId || 1;
    const employeeId = user.employeeId || 1;

    let project = null;
    if (data.project_id) {
      project = await p.project.findFirst({
        where: { id: data.project_id, company_id: companyId }
      });
      if (!project) {
        throw { status: 400, message: 'Invalid or unauthorized project reference' };
      }
    }

    const propertyCode = await this.generateNextPropertyCode();

    let finalPmId = null;
    if (data.assigned_pm_id) {
      // Explicit PM assignment
      const pm = await p.employee.findFirst({
        where: { id: data.assigned_pm_id, company_id: companyId, status: 'ACTIVE' }
      });
      if (!pm) {
        throw { status: 400, message: 'Invalid or unauthorized project manager assigned' };
      }
      finalPmId = pm.id;
    } else if (project && project.assigned_pm_id) {
      // Inherit from project
      finalPmId = project.assigned_pm_id;
    }

    if (!finalPmId && data.city) {
      // Find PMs assigned to this city
      const assignments = await p.pMLocationAssignment.findMany({
        where: { location: data.city, company_id: companyId },
        select: { pm_id: true }
      });

      if (assignments.length === 1) {
        finalPmId = assignments[0].pm_id;
      } else if (assignments.length > 1) {
        // Tiebreaker: lowest PENDING_VERIFICATION load
        const pmIds = assignments.map((a: any) => a.pm_id);
        const loads = await p.property.groupBy({
          by: ['assigned_pm_id'],
          where: { assigned_pm_id: { in: pmIds }, status: 'PENDING_VERIFICATION' },
          _count: { assigned_pm_id: true }
        });

        // Initialize all PMs with 0 load
        const loadMap = new Map<number, number>();
        pmIds.forEach((id: number) => loadMap.set(id, 0));
        
        loads.forEach((l: any) => {
          if (l.assigned_pm_id !== null) {
            loadMap.set(l.assigned_pm_id, l._count.assigned_pm_id);
          }
        });

        let minLoad = Infinity;
        let selectedPmId = pmIds[0];

        for (const [id, count] of loadMap.entries()) {
          if (count < minLoad) {
            minLoad = count;
            selectedPmId = id;
          }
        }
        finalPmId = selectedPmId;
      }
    }

    return await p.$transaction(async (tx: import('@prisma/client').Prisma.TransactionClient) => {
      const baseSlug = slugify(`${data.title} ${data.location} ${data.category}`);
      const slug = await generateUniqueSlug(baseSlug, companyId, async (s: string, cId: number) => {
        const existing = await tx.property.findFirst({ where: { slug: s, company_id: cId } });
        return !!existing;
      });

      const property = await tx.property.create({
        data: {
          property_code: propertyCode,
          company_id: companyId,
          branch_id: branchId,
          title: data.title,
          description: data.description || null,
          brand_type: data.brand_type,
          category: data.category,
          price: data.price,
          area_sqft: data.area_sqft,
          location: data.location,
          address: data.address || null,
          bedrooms: data.bedrooms ? Number(data.bedrooms) : null,
          bathrooms: data.bathrooms ? Number(data.bathrooms) : null,
          project_id: data.project_id || null,
          facing: data.facing || null,
          amenities: data.amenities || null,
          possession_status: data.possession_status || null,
          details: data.details || null,
          assigned_pm_id: finalPmId,
          status: 'PENDING_VERIFICATION',
          created_by_id: employeeId,
          // WR-2: Structured location fields
          state: data.state || null,
          city: data.city || null,
          locality: data.locality || null,
          pincode: data.pincode || null,
          latitude: data.latitude != null ? Number(data.latitude) : null,
          longitude: data.longitude != null ? Number(data.longitude) : null,
          listing_type: data.listing_type || 'NEW',
          source: data.source || 'INTERNAL',
          // WR-6: SEO slug
          slug,
        },
      });

      if (data.faqs && Array.isArray(data.faqs) && data.faqs.length > 0) {
        // TODO: Schema migration required to add PropertyFAQ model
        // Skipping FAQ creation to prevent runtime crash on missing model.
      }

      await tx.propertyVerificationLog.create({
        data: {
          property_id: property.id,
          actor_id: employeeId,
          from_status: 'DRAFT',
          to_status: 'PENDING_VERIFICATION',
          notes: `Property ${propertyCode} submitted. Assigned to PM ID ${finalPmId || 'Queue'} for On-Site Verification.`,
        },
      });

      if (!finalPmId) {
        const mdEmployees = await tx.employee.findMany({
          where: {
            company_id: companyId,
            status: 'ACTIVE',
            roles: {
              some: {
                role: {
                  name: Roles.MD
                }
              }
            }
          },
          select: { id: true }
        });

        if (mdEmployees.length > 0) {
          await tx.notification.createMany({
            data: mdEmployees.map((md: any) => ({
              employee_id: md.id,
              type: 'SYSTEM_ALERT',
              title: 'Property Requires PM Assignment',
              message: `Property ${propertyCode} (${data.title}) was created without an assigned PM. Location: ${data.city || 'Unknown'}`
            }))
          });
        }
      }

      return property;
    });
  }

  static async updateProperty(user: TokenPayload, propertyId: number, data: any) {
    if (!can(user, Permissions.PROPERTIES_UPDATE)) {
      throw { status: 403, message: 'Forbidden: Missing properties.update permission' };
    }

    const companyId = user.companyId || 1;

    // Validate that the property exists and belongs to the allowed scope
    const whereCondition = await buildPropertyScope(user);
    const property = await p.property.findFirst({
      where: {
        id: propertyId,
        ...whereCondition,
      }
    });

    if (!property) throw { status: 404, message: 'Property not found or unauthorized' };

    // Validate project_id cross-company reference if provided
    if (data.project_id) {
      const project = await p.project.findFirst({
        where: { id: data.project_id, company_id: companyId }
      });
      if (!project) throw { status: 400, message: 'Invalid or unauthorized project reference' };
    }

    if (data.assigned_pm_id && data.assigned_pm_id !== property.assigned_pm_id) {
      const pm = await p.employee.findFirst({
        where: { id: data.assigned_pm_id, company_id: companyId }
      });
      if (!pm) throw { status: 400, message: 'Invalid assigned_pm_id or does not belong to your company' };
    }

    // Explicitly exclude workflow fields
    const safeData: any = {};
    const safeKeys = [
      'title', 'description', 'brand_type', 'category', 'price', 'area_sqft', 
      'location', 'address', 'bedrooms', 'bathrooms', 'facing', 'amenities', 
      'possession_status', 'assigned_pm_id', 'project_id', 'details',
      // WR-2: Structured location fields
      'state', 'city', 'locality', 'pincode', 'latitude', 'longitude', 'listing_type'
    ];

    for (const key of safeKeys) {
      if (data[key] !== undefined) {
        if (key === 'bedrooms' || key === 'bathrooms') {
          safeData[key] = data[key] ? Number(data[key]) : null;
        } else if (key === 'latitude' || key === 'longitude') {
          safeData[key] = data[key] != null ? Number(data[key]) : null;
        } else {
          safeData[key] = data[key];
        }
      }
    }

    const updatedProperty = await p.property.update({
      where: { id: propertyId },
      data: safeData,
    });

    if (updatedProperty.status === 'LIVE') {
      import('./lead.service').then(({ LeadService }) => {
        LeadService.triggerLeadRecoveryForProperty(updatedProperty.id).catch(err => 
          logger.error(`Error triggering lead recovery for property ${updatedProperty.id}:`, err)
        );
      });
    }

    return updatedProperty;
  }

  static async verifyProperty(user: TokenPayload, propertyId: number, data: { approved: boolean; notes: string }) {
    const property = await p.property.findFirst({
      where: { id: propertyId, company_id: user.companyId },
      include: {
        // Only count photos uploaded by THIS PM — seller-submitted or third-party photos
        // do not satisfy the "PM took on-site pictures" requirement.
        images: {
          where: { uploaded_by_id: user.employeeId },
          select: { id: true },
        },
      },
    });
    if (!property) throw { status: 404, message: 'Property not found' };

    if (!can(user, Permissions.PROPERTIES_VERIFY, property)) {
      throw { status: 403, message: 'Forbidden: Insufficient permissions or out of scope' };
    }

    const transition = WorkflowEngine.canTransition({
      domain: WorkflowDomain.PROPERTY,
      currentState: property.status,
      action: 'VERIFY',
      actor: user,
      entity: property,
    });

    if (!transition.allowed) {
      throw { status: 409, message: transition.reason || 'Invalid state transition' };
    }

    // Pre-conditions apply only on the APPROVE path — rejection has no requirements
    if (data.approved) {
      if ((property as any).images.length === 0) {
        throw {
          status: 400,
          message: 'Cannot approve: at least one photo uploaded by you (the assigned PM) is required before verification.',
        };
      }

      if (!(property as any).location_confirmed_by_pm) {
        throw {
          status: 400,
          message: 'Cannot approve: PM must confirm location details on-site before verification (use the Confirm Location action).',
        };
      }
    }

    const nextStatus = data.approved ? 'PENDING_DM_POLISH' : 'REJECTED';

    return await p.$transaction(async (tx: import('@prisma/client').Prisma.TransactionClient) => {
      const updated = await tx.property.update({
        where: { id: propertyId },
        data: {
          status: nextStatus,
          verified_by_pm_at: data.approved ? new Date() : null,
          rejection_reason: data.approved ? null : data.notes,
        },
      });

      await tx.propertyVerificationLog.create({
        data: {
          property_id: propertyId,
          actor_id: user.employeeId || 1,
          from_status: property.status,
          to_status: nextStatus,
          notes: `PM On-Site Verification: ${data.approved ? 'PASSED' : 'REJECTED'}. Notes: ${data.notes}`,
        },
      });

      return updated;
    });
  }

  /**
   * PM explicitly confirms that location details (city, locality, lat/lng) match
   * what was observed on-site. This is a prerequisite for verifyProperty to succeed.
   * Requires PROPERTIES_VERIFY permission — same gate as the verify action itself.
   */
  static async confirmLocationByPM(user: TokenPayload, propertyId: number) {
    const property = await p.property.findFirst({ where: { id: propertyId, company_id: user.companyId } });
    if (!property) throw { status: 404, message: 'Property not found' };

    if (!can(user, Permissions.PROPERTIES_VERIFY, property)) {
      throw { status: 403, message: 'Forbidden: Only the assigned PM (or MD/Admin) can confirm location for this property' };
    }

    if (property.status !== 'PENDING_VERIFICATION') {
      throw { status: 409, message: 'Location confirmation is only applicable while the property is in PENDING_VERIFICATION status' };
    }

    return await p.property.update({
      where: { id: propertyId },
      data: { location_confirmed_by_pm: true },
      select: { id: true, property_code: true, location_confirmed_by_pm: true },
    });
  }

  static async dmPolishProperty(user: TokenPayload, propertyId: number, data: any) {
    const property = await p.property.findFirst({ where: { id: propertyId, company_id: user.companyId } });
    if (!property) throw { status: 404, message: 'Property not found' };

    if (!can(user, Permissions.PROPERTIES_DM_POLISH, property)) {
      throw { status: 403, message: 'Forbidden: Insufficient permissions or out of scope' };
    }

    const transition = WorkflowEngine.canTransition({
      domain: WorkflowDomain.PROPERTY,
      currentState: property.status,
      action: 'DM_POLISH',
      actor: user,
      entity: property,
    });

    if (!transition.allowed) {
      throw { status: 409, message: transition.reason || 'Invalid state transition' };
    }

    return await p.$transaction(async (tx: import('@prisma/client').Prisma.TransactionClient) => {
      const updated = await tx.property.update({
        where: { id: propertyId },
        data: {
          status: 'PENDING_MD_APPROVAL',
          seo_title: data.seo_title || property.seo_title,
          seo_keywords: data.seo_keywords || property.seo_keywords,
          description: data.description || property.description,
          digital_marketing_executive_id: data.digital_marketing_executive_id,
          dm_polished_at: new Date(),
        },
      });

      await tx.propertyVerificationLog.create({
        data: {
          property_id: propertyId,
          actor_id: user.employeeId || 1,
          from_status: property.status,
          to_status: 'PENDING_MD_APPROVAL',
          notes: `Digital Marketing Polish Completed. Submitted for MD Final Approval.${data.notes ? ` Notes: ${data.notes}` : ''}`,
        },
      });

      return updated;
    });
  }

  /**
   * DM Head "Verified As-Is" bypass — skips the polish step and advances the property
   * directly to PENDING_MD_APPROVAL without assigning a DM Executive.
   * Requires PROPERTIES_DM_POLISH permission (same gate as the standard polish path).
   */
  static async dmVerifyAsIsProperty(user: TokenPayload, propertyId: number, data: { notes?: string }) {
    const property = await p.property.findFirst({ where: { id: propertyId, company_id: user.companyId } });
    if (!property) throw { status: 404, message: 'Property not found' };

    if (!can(user, Permissions.PROPERTIES_DM_POLISH, property)) {
      throw { status: 403, message: 'Forbidden: Insufficient permissions or out of scope' };
    }

    const transition = WorkflowEngine.canTransition({
      domain: WorkflowDomain.PROPERTY,
      currentState: property.status,
      action: 'DM_VERIFY_AS_IS',
      actor: user,
      entity: property,
    });

    if (!transition.allowed) {
      throw { status: 409, message: transition.reason || 'Invalid state transition' };
    }

    return await p.$transaction(async (tx: import('@prisma/client').Prisma.TransactionClient) => {
      const updated = await tx.property.update({
        where: { id: propertyId },
        data: {
          status: 'PENDING_MD_APPROVAL',
          // Mark dm_polished_at so the audit trail shows a DM Head reviewed it
          dm_polished_at: new Date(),
        },
      });

      await tx.propertyVerificationLog.create({
        data: {
          property_id: propertyId,
          actor_id: user.employeeId || 1,
          from_status: property.status,
          to_status: 'PENDING_MD_APPROVAL',
          notes: `Digital Marketing Head verified property as-is (no polish required). Submitted directly for MD Final Approval.${data.notes ? ` Notes: ${data.notes}` : ''}`,
        },
      });

      return updated;
    });
  }

  static async mdApproveProperty(user: TokenPayload, propertyId: number, data: { approved: boolean; comments?: string }) {
    const property = await p.property.findFirst({ where: { id: propertyId, company_id: user.companyId } });
    if (!property) throw { status: 404, message: 'Property not found' };

    if (!can(user, Permissions.PROPERTIES_MD_APPROVE, property)) {
      throw { status: 403, message: 'Forbidden: Insufficient permissions or out of scope' };
    }

    const transition = WorkflowEngine.canTransition({
      domain: WorkflowDomain.PROPERTY,
      currentState: property.status,
      action: 'MD_APPROVE',
      actor: user,
      entity: property,
    });

    if (!transition.allowed) {
      throw { status: 409, message: transition.reason || 'Invalid state transition' };
    }

    const nextStatus = data.approved ? 'LIVE' : 'REJECTED';

    const result = await p.$transaction(async (tx: import('@prisma/client').Prisma.TransactionClient) => {
      const updated = await tx.property.update({
        where: { id: propertyId },
        data: {
          status: nextStatus,
          md_approved_at: data.approved ? new Date() : null,
          rejection_reason: data.approved ? null : data.comments,
        },
      });

      await tx.propertyVerificationLog.create({
        data: {
          property_id: propertyId,
          actor_id: user.employeeId || 1,
          from_status: property.status,
          to_status: nextStatus,
          notes: `MD Decision: ${data.approved ? 'APPROVED & LIVE' : 'REJECTED'}.${data.comments ? ` Comments: ${data.comments}` : ''}`,
        },
      });

      await tx.auditEvent.create({
        data: {
          actor_id: user.employeeId || 1,
          action: data.approved ? 'PROPERTY_MD_APPROVED_LIVE' : 'PROPERTY_MD_REJECTED',
          entity_type: 'PROPERTY',
          entity_id: propertyId,
          old_value: JSON.stringify({ status: property.status }),
          new_value: JSON.stringify({ status: nextStatus, comments: data.comments }),
        },
      });

      return updated;
    });

    if (result.status === 'LIVE') {
      import('./lead.service').then(({ LeadService }) => {
        LeadService.triggerLeadRecoveryForProperty(result.id).catch(err => 
          logger.error(`Error triggering lead recovery for property ${result.id}:`, err)
        );
      });
    }

    return result;
  }

  static async togglePublication(user: TokenPayload, propertyId: number, companyId: number, isPublished: boolean) {
    if (!can(user, Permissions.PROPERTIES_UPDATE)) {
      throw { status: 403, message: 'Forbidden: Missing properties.update permission' };
    }

    const property = await p.property.findFirst({
      where: { id: propertyId, company_id: user.companyId },
    });
    if (!property) throw { status: 404, message: 'Property not found or unauthorized' };

    if (companyId !== user.companyId) {
      throw { status: 403, message: 'Cannot publish to a different company' };
    }

    const publication = await p.propertyPublication.upsert({
      where: {
        property_id_company_id: { property_id: propertyId, company_id: companyId },
      },
      update: {
        is_published: isPublished,
        published_at: isPublished ? new Date() : null,
      },
      create: {
        property_id: propertyId,
        company_id: companyId,
        is_published: isPublished,
        published_at: isPublished ? new Date() : null,
      },
    });

    return publication;
  }

  static async getPublications(user: TokenPayload, propertyId: number) {
    if (!can(user, Permissions.PROPERTIES_READ)) {
      throw { status: 403, message: 'Forbidden: Missing properties.read permission' };
    }

    const property = await p.property.findFirst({
      where: { id: propertyId, company_id: user.companyId },
    });
    if (!property) throw { status: 404, message: 'Property not found or unauthorized' };

    return await p.propertyPublication.findMany({
      where: { property_id: propertyId },
      include: { company: { select: { id: true, name: true, code: true } } },
    });
  }

  static async reassignProperty(user: TokenPayload, propertyId: number, newPmId: number, reason: string) {
    if (!can(user, Permissions.PROPERTIES_UPDATE)) { // MD/Admin typically have this
      throw { status: 403, message: 'Forbidden: Missing permission to reassign property' };
    }
    if (!reason || reason.trim() === '') {
      throw { status: 400, message: 'Reassignment reason is mandatory' };
    }

    const property = await p.property.findFirst({
      where: { id: propertyId, company_id: user.companyId }
    });
    if (!property) throw { status: 404, message: 'Property not found or unauthorized' };

    const newPm = await p.employee.findFirst({
      where: { id: newPmId, company_id: user.companyId, status: 'ACTIVE' }
    });
    if (!newPm) throw { status: 400, message: 'New assignee not found or unauthorized' };

    const oldPmId = property.assigned_pm_id;

    return await p.$transaction(async (tx: import('@prisma/client').Prisma.TransactionClient) => {
      const updated = await tx.property.update({
        where: { id: propertyId },
        data: { assigned_pm_id: newPmId }
      });

      await tx.auditEvent.create({
        data: {
          actor_id: user.employeeId!,
          action: 'REASSIGNMENT',
          entity_type: 'PROPERTY',
          entity_id: propertyId,
          old_value: oldPmId ? oldPmId.toString() : 'UNASSIGNED',
          new_value: newPmId.toString(),
          reason: reason
        }
      });

      return updated;
    });
  }
}

