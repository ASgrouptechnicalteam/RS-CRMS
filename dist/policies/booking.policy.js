"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BookingPolicy = void 0;
const shared_1 = require("../shared");
/**
 * Phase 5 - Booking Resource Scope Policy
 * Enforces ownership and cross-company boundaries before mutating data.
 */
class BookingPolicy {
    /**
     * Identifies if a user holds a management role with global booking access within their company.
     */
    static isManagement(user) {
        return user.roles.some((r) => [
            shared_1.Roles.MD,
            shared_1.Roles.ADMIN,
            shared_1.Roles.HR_MANAGER,
            shared_1.Roles.FINANCE,
            shared_1.Roles.MARKETING_DIRECTOR,
            shared_1.Roles.DIGITAL_LEAD_OPERATOR,
            shared_1.Roles.PROJECT_MANAGER,
        ].includes(r));
    }
    /**
     * Determines if the user is permitted to view the booking.
     * - Must belong to the same company.
     * - Management can view all bookings in the company.
     * - Agents/Telecallers can only view bookings assigned to them.
     */
    static canView(user, booking) {
        if (booking.company_id !== user.companyId) {
            return false; // Never allow cross-company access
        }
        if (this.isManagement(user)) {
            return true;
        }
        // Telecallers/Agents: Assigned access only
        return booking.assigned_employee_id === user.employeeId;
    }
    /**
     * Determines if the user is permitted to mutate (update/cancel/confirm) the booking.
     */
    static canMutate(user, booking) {
        return this.canView(user, booking);
    }
}
exports.BookingPolicy = BookingPolicy;
