import { TokenPayload } from '../utils/jwt';
import { Roles, Permissions } from '../shared';
import { Property } from '@prisma/client';

/**
 * Property.status values before the MD approves (LIVE). A Digital Marketing
 * Executive may change a property they created or are assigned only while it
 * is in one of these (item 3, 2026-11-15). Unknown => locked.
 */
export const DM_EXECUTIVE_EDITABLE_PROPERTY = [
  'DRAFT',
  'PENDING_VERIFICATION',
  'PENDING_DM_POLISH',
  'PENDING_MD_APPROVAL',
  'REJECTED',
];

export class PropertyPolicy {
  /**
   * A Project Manager "owns" a record when it is assigned to them, or when
   * they created it and nobody has been assigned yet -- without the second
   * case a PM who creates something with no PM set could not edit their own
   * new record.
   */
  private static isOwningPm(
    user: TokenPayload,
    rec: { assigned_pm_id: number | null; created_by_id?: number | null },
  ): boolean {
    if (rec.assigned_pm_id === user.employeeId) return true;
    return rec.assigned_pm_id == null && rec.created_by_id === user.employeeId;
  }

  private static isManagement(user: TokenPayload): boolean {
    return user.roles.some((r) =>
      [
        Roles.MD,
        Roles.ADMIN,
        Roles.HR_MANAGER,
        Roles.MARKETING_DIRECTOR,
        Roles.DIGITAL_LEAD_OPERATOR,
        Roles.DIGITAL_MARKETING_HEAD,
      ].includes(r as any),
    );
  }

  static canCreate(user: TokenPayload): boolean {
    return (user.permissions || []).includes(Permissions.PROPERTIES_CREATE);
  }

  /**
   * Determines whether a user may update a specific Property.
   * Mirrors ProjectPolicy.canUpdate. Was previously routed through canVerify
   * in authorization.ts's switch statement — incorrect, since that requires
   * PROPERTIES_VERIFY specifically and assignment-as-PM, which would wrongly
   * block e.g. a DM Executive with PROPERTIES_UPDATE editing SEO fields.
   * (Latent until now: no caller passed a resource for this action.)
   */
  static canUpdate(user: TokenPayload, property: Property): boolean {
    if (!(user.permissions || []).includes(Permissions.PROPERTIES_UPDATE)) {
      return false;
    }
    // ADMIN bypasses company scoping entirely — matches buildPropertyScope's
    // own `user.roles.includes(Roles.ADMIN) ? {} : ...` and ProjectPolicy's
    // equivalent methods. Was previously an unconditional mismatch check that
    // would 403 an Admin acting on a property outside their own companyId.
    if (!user.roles.includes(Roles.ADMIN) && property.company_id !== user.companyId) {
      return false;
    }
    if (user.roles.includes(Roles.ADMIN) || this.isManagement(user)) {
      return true;
    }
    // Inventory Executive edits every project/property in the company on
    // the PMs' behalf (no delete -- they don't hold the delete permission).
    if (
      user.roles.includes(Roles.INVENTORY_EXECUTIVE) ||
      user.roles.includes(Roles.DATA_ENTRY_OPERATOR)
    )
      return true;

    if (user.roles.includes(Roles.PROJECT_MANAGER)) {
      return this.isOwningPm(user, property);
    }
    // Digital Marketing Executive: a property they added themselves, until the
    // MD approves it. An assigned polish step is DM_POLISH work, not edits.
    if (user.roles.includes(Roles.DIGITAL_MARKETING_EXECUTIVE)) {
      return (
        property.created_by_id === user.employeeId &&
        DM_EXECUTIVE_EDITABLE_PROPERTY.includes(property.status)
      );
    }
    return false;
  }

  /**
   * Digital Marketing Executive: a property they created or are assigned for
   * polish, until the MD approves it (LIVE and after are locked). Used for
   * approving / rejecting its images (item 3, 2026-11-15).
   */
  static executiveMayTouch(
    user: TokenPayload,
    property: Pick<Property, 'status' | 'created_by_id' | 'digital_marketing_executive_id'>,
  ): boolean {
    const mine =
      property.created_by_id === user.employeeId ||
      property.digital_marketing_executive_id === user.employeeId;
    return mine && DM_EXECUTIVE_EDITABLE_PROPERTY.includes(property.status);
  }

  /**
   * Approving / rejecting a property image (needs PROPERTIES_DM_POLISH). Was
   * open to any holder on any property, LIVE included: an Executive could
   * change the photos of an approved listing. Management (Head included,
   * owner decision 7) stays unlocked; an Executive follows executiveMayTouch.
   */
  static canReviewImage(
    user: TokenPayload,
    property: Pick<
      Property,
      'company_id' | 'status' | 'created_by_id' | 'digital_marketing_executive_id'
    >,
  ): boolean {
    if (!(user.permissions || []).includes(Permissions.PROPERTIES_DM_POLISH)) return false;
    if (!user.roles.includes(Roles.ADMIN) && property.company_id !== user.companyId) return false;
    if (user.roles.includes(Roles.ADMIN) || this.isManagement(user)) return true;
    if (user.roles.includes(Roles.DIGITAL_MARKETING_EXECUTIVE)) {
      return this.executiveMayTouch(user, property);
    }
    return true;
  }

  /**
   * Only Admin and Technical Manager (whose token carries the Admin role) may
   * delete (archive) a Property (owner, 2026-11-04). See ProjectPolicy.canDelete.
   */
  static canDelete(user: TokenPayload, property: Property): boolean {
    if (!(user.permissions || []).includes(Permissions.PROPERTIES_DELETE)) {
      return false;
    }
    return user.roles.includes(Roles.ADMIN);
  }

  /** Replacing a property's PM: MD, Admin and Technical Manager only. */
  static canChangePm(user: TokenPayload): boolean {
    return user.roles.includes(Roles.MD) || user.roles.includes(Roles.ADMIN);
  }

  static canVerify(user: TokenPayload, property: Property): boolean {
    if (!(user.permissions || []).includes(Permissions.PROPERTIES_VERIFY)) {
      return false;
    }
    // Same ADMIN-bypass fix as canUpdate/canDelete above — this had the same
    // latent bug (unconditional company mismatch check ahead of the Admin
    // check), just never exercised by a cross-company Admin verify before.
    if (!user.roles.includes(Roles.ADMIN) && property.company_id !== user.companyId) {
      return false;
    }
    // MD/Admin can bypass assignment check
    if (user.roles.includes(Roles.MD) || user.roles.includes(Roles.ADMIN)) {
      return true;
    }
    // Must be explicitly assigned to this PM
    return property.assigned_pm_id === user.employeeId;
  }

  static canDMPolish(user: TokenPayload, property: Property): boolean {
    if (!(user.permissions || []).includes(Permissions.PROPERTIES_DM_POLISH)) {
      return false;
    }
    return user.roles.includes(Roles.ADMIN) || property.company_id === user.companyId;
  }

  static canMDApprove(user: TokenPayload, property: Property): boolean {
    if (!(user.permissions || []).includes(Permissions.PROPERTIES_MD_APPROVE)) {
      return false;
    }
    return user.roles.includes(Roles.ADMIN) || property.company_id === user.companyId;
  }
}
