"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DocumentPolicy = exports.KYC_DOCUMENT_TYPES = void 0;
const shared_1 = require("@rrh-ems/shared");
const KYC_TYPES = ['KYC_PAN', 'KYC_AADHAAR'];
exports.KYC_DOCUMENT_TYPES = KYC_TYPES;
const MANAGEMENT_ROLES = [
    shared_1.Roles.MD,
    shared_1.Roles.ADMIN,
    shared_1.Roles.HR_MANAGER,
    shared_1.Roles.FINANCE,
    shared_1.Roles.MARKETING_DIRECTOR,
    shared_1.Roles.DIGITAL_LEAD_OPERATOR,
    shared_1.Roles.PROJECT_MANAGER,
];
const KYC_AUTHORIZED_ROLES = [
    shared_1.Roles.MD,
    shared_1.Roles.ADMIN,
    shared_1.Roles.HR_MANAGER,
    shared_1.Roles.FINANCE,
];
class DocumentPolicy {
    static isManagement(user) {
        return user.roles.some((r) => MANAGEMENT_ROLES.includes(r));
    }
    static isKYCRole(user) {
        return user.roles.some((r) => KYC_AUTHORIZED_ROLES.includes(r));
    }
    static isKYCType(documentType) {
        return KYC_TYPES.includes(documentType);
    }
    static canView(user, doc) {
        if (doc.company_id !== user.companyId)
            return false;
        if (doc.deleted_at)
            return this.isManagement(user);
        if (this.isKYCType(doc.document_type))
            return this.isKYCRole(user);
        if (this.isManagement(user))
            return true;
        return doc.uploaded_by_id === user.employeeId;
    }
    static canCreate(user) {
        return (user.permissions || []).includes(shared_1.Permissions.DOCUMENTS_CREATE);
    }
    static canVerify(user, doc) {
        if (!(user.permissions || []).includes(shared_1.Permissions.DOCUMENTS_VERIFY))
            return false;
        if (doc.company_id !== user.companyId)
            return false;
        if (doc.deleted_at)
            return false;
        return true;
    }
    static canDelete(user, doc) {
        if (!(user.permissions || []).includes(shared_1.Permissions.DOCUMENTS_DELETE))
            return false;
        if (doc.company_id !== user.companyId)
            return false;
        if (doc.deleted_at)
            return false;
        return true;
    }
    static canRestore(user, doc) {
        if (!(user.permissions || []).includes(shared_1.Permissions.DOCUMENTS_DELETE))
            return false;
        if (doc.company_id !== user.companyId)
            return false;
        if (!doc.deleted_at)
            return false;
        return true;
    }
    static canDownload(user, doc) {
        return this.canView(user, doc);
    }
}
exports.DocumentPolicy = DocumentPolicy;
