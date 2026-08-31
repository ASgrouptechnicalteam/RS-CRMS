"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PropertyPolicy = void 0;
const shared_1 = require("../shared");
class PropertyPolicy {
    static isManagement(user) {
        return user.roles.some((r) => [
            shared_1.Roles.MD,
            shared_1.Roles.ADMIN,
            shared_1.Roles.HR_MANAGER,
            shared_1.Roles.MARKETING_DIRECTOR,
            shared_1.Roles.DIGITAL_LEAD_OPERATOR,
            shared_1.Roles.DIGITAL_MARKETING_HEAD,
        ].includes(r));
    }
    static canCreate(user) {
        return (user.permissions || []).includes(shared_1.Permissions.PROPERTIES_CREATE);
    }
    static canVerify(user, property) {
        if (!(user.permissions || []).includes(shared_1.Permissions.PROPERTIES_VERIFY)) {
            return false;
        }
        if (property.company_id !== user.companyId) {
            return false;
        }
        // MD/Admin can bypass assignment check
        if (user.roles.includes(shared_1.Roles.MD) || user.roles.includes(shared_1.Roles.ADMIN)) {
            return true;
        }
        // Must be explicitly assigned to this PM
        return property.assigned_pm_id === user.employeeId;
    }
    static canDMPolish(user, property) {
        if (!(user.permissions || []).includes(shared_1.Permissions.PROPERTIES_DM_POLISH)) {
            return false;
        }
        return property.company_id === user.companyId;
    }
    static canMDApprove(user, property) {
        if (!(user.permissions || []).includes(shared_1.Permissions.PROPERTIES_MD_APPROVE)) {
            return false;
        }
        return property.company_id === user.companyId;
    }
}
exports.PropertyPolicy = PropertyPolicy;
