import { TokenPayload } from '../utils/jwt';
import { Roles, Permissions } from '../shared';
import { Property } from '@prisma/client';

export class PropertyPolicy {
  private static isManagement(user: TokenPayload): boolean {
    return user.roles.some((r) =>
      [
        Roles.MD,
        Roles.ADMIN,
        Roles.HR_MANAGER,
        Roles.MARKETING_DIRECTOR,
        Roles.DIGITAL_LEAD_OPERATOR,
        Roles.DIGITAL_MARKETING_HEAD,
      ].includes(r as any)
    );
  }

  static canCreate(user: TokenPayload): boolean {
    return (user.permissions || []).includes(Permissions.PROPERTIES_CREATE);
  }


  static canVerify(user: TokenPayload, property: Property): boolean {
    if (!(user.permissions || []).includes(Permissions.PROPERTIES_VERIFY)) {
      return false;
    }
    if (property.company_id !== user.companyId) {
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
    return property.company_id === user.companyId;
  }

  static canMDApprove(user: TokenPayload, property: Property): boolean {
    if (!(user.permissions || []).includes(Permissions.PROPERTIES_MD_APPROVE)) {
      return false;
    }
    return property.company_id === user.companyId;
  }
}
