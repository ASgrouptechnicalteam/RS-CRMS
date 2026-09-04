"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CustomerPortalService = void 0;
const prisma_1 = require("../lib/prisma");
const customer_service_1 = require("./customer.service");
/**
 * Stub provisioner — does NOT make a network call. It records intent in the
 * audit log and returns a synthetic result so the booking flow can complete
 * end-to-end in dev/test until the real portal contract is finalized.
 */
class StubCustomerPortalProvisioner {
    async provision(input) {
        await prisma_1.prisma.auditEvent.create({
            data: {
                actor_id: input.actorId,
                action: 'CUSTOMER_PORTAL_PROVISION_STUB',
                entity_type: 'CUSTOMER',
                entity_id: input.customerId,
                old_value: JSON.stringify({ status: 'PENDING_EXTERNAL_PROVISION' }),
                new_value: JSON.stringify({
                    provisioner: 'stub',
                    company_id: input.companyId,
                    lead_id: input.leadId,
                    customer_code: input.customerCode,
                    note: 'Customer portal contract TBD (spec §8 item #3) — stub only. Credentials masked.',
                }),
            },
        });
        return { provisioned: false, provisioner: 'stub' };
    }
}
// Single switch-point for the real implementation later.
const provisioner = new StubCustomerPortalProvisioner();
class CustomerPortalService {
    /**
     * Convert the lead to a customer (reusing CustomerService) and attempt portal
     * provisioning. Runs inside the caller's transaction so a failure rolls back
     * the BOOKED status write too.
     */
    static async provisionStub(tx, lead, user) {
        const bcrypt = await Promise.resolve().then(() => __importStar(require('bcryptjs')));
        const crypto = await Promise.resolve().then(() => __importStar(require('crypto')));
        const { generateWhatsAppLink } = await Promise.resolve().then(() => __importStar(require('../utils/whatsapp')));
        // 1. Reuse existing convert-to-customer logic (handles idempotency via
        //    Customer.origin_lead_id unique constraint).
        const customer = await customer_service_1.CustomerService.upsertFromLead(user, lead.id, tx);
        // 2. Generate a cryptographically secure temporary password (8 chars)
        const tempPassword = crypto.randomBytes(4).toString('hex').toLowerCase();
        const passwordHash = await bcrypt.hash(tempPassword, 12);
        // 3. Set temporary credentials and force reset on first login
        await tx.customer.update({
            where: { id: customer.id },
            data: {
                password_hash: passwordHash,
                temp_password_expiry: new Date(Date.now() + 24 * 60 * 60 * 1000), // expires in 24 hours
                force_password_reset: true
            }
        });
        // 4. Provision via the (stub) portal provisioner.
        const result = await provisioner.provision({
            actorId: user.employeeId,
            companyId: lead.company_id,
            leadId: lead.id,
            customerId: customer.id,
            customerCode: customer.customer_code,
        });
        // 5. Generate WhatsApp credential-delivery message for the PM to send manually
        const whatsappLink = generateWhatsAppLink(lead.phone, 'CREDENTIAL_DELIVERY', {
            customer_name: lead.customer_name,
            phone: lead.phone,
            password: tempPassword,
        });
        await tx.leadActivity.create({
            data: {
                lead_id: lead.id,
                actor_id: user.employeeId,
                activity_type: 'CREDENTIALS_GENERATED',
                notes: `Customer portal credentials generated. PM must send this message manually: ${whatsappLink}`
            }
        });
        return result;
    }
    /**
     * §6 — external trigger variant of {@link provisionStub}. Used by the HTTP
     * route POST /integrations/customer-portal/provision. Looks up the lead and
     * runs inside a fresh transaction (unlike the internal BOOKED hook which joins
     * the caller's transaction).
     */
    static async provisionStubForLead(user, leadId) {
        const lead = await prisma_1.prisma.lead.findFirst({
            where: { id: leadId, company_id: user.companyId },
        });
        if (!lead) {
            throw new Error('Lead not found');
        }
        return await prisma_1.prisma.$transaction(async (tx) => {
            return await CustomerPortalService.provisionStub(tx, lead, user);
        });
    }
}
exports.CustomerPortalService = CustomerPortalService;
