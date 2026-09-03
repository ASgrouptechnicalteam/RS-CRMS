"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const client_1 = require("@prisma/client");
const auth_1 = require("../middleware/auth");
const shared_1 = require("@rrh-ems/shared");
const validate_1 = require("../middleware/validate");
const authz_1 = require("../middleware/authz");
const authorization_1 = require("../authz/authorization");
const router = (0, express_1.Router)();
const prisma = new client_1.PrismaClient();
const p = prisma;
// Code Generator: RRH-CP-YYYY-XXXX
const generateNextCPCode = async () => {
    const currentYear = new Date().getFullYear();
    const count = await p.channelPartner.count();
    const seq = (count + 1).toString().padStart(4, '0');
    return `RRH-CP-${currentYear}-${seq}`;
};
// Code Generator: RRH-PO-YYYY-XXXX
const generateNextPayoutCode = async () => {
    const currentYear = new Date().getFullYear();
    const count = await p.cPPayout.count();
    const seq = (count + 1).toString().padStart(4, '0');
    return `RRH-PO-${currentYear}-${seq}`;
};
// GET /api/v1/cp - List Channel Partners & Upline Network
router.get('/', auth_1.authenticateToken, async (req, res) => {
    try {
        const companyId = req.user?.companyId || req.user?.company_id || 1;
        const channelPartners = await p.channelPartner.findMany({
            where: { company_id: companyId },
            include: {
                upline_cp: { select: { id: true, cp_code: true, firm_name: true, contact_name: true } },
                payouts: {
                    select: { id: true, commission_amount: true, status: true },
                },
                protection_locks: {
                    where: { lock_status: 'ACTIVE' },
                    include: { lead: { select: { id: true, lead_code: true, customer_name: true } } },
                },
            },
            orderBy: { created_at: 'desc' },
        });
        const enriched = channelPartners.map((cp) => {
            const totalEarned = cp.payouts
                .filter((po) => po.status === 'DISBURSED' || po.status === 'APPROVED')
                .reduce((sum, po) => sum + po.commission_amount, 0);
            const pendingAmount = cp.payouts
                .filter((po) => po.status === 'PENDING_MD_APPROVAL')
                .reduce((sum, po) => sum + po.commission_amount, 0);
            return {
                ...cp,
                totalEarned,
                pendingAmount,
                activeProtectedLeads: cp.protection_locks.length,
            };
        });
        return res.status(200).json({ channelPartners: enriched });
    }
    catch (error) {
        console.error('Fetch CPs error:', error);
        return res.status(500).json({ error: 'Failed to fetch channel partners' });
    }
});
// POST /api/v1/cp - Register New Channel Partner
router.post('/', auth_1.authenticateToken, (0, authz_1.requireAuthz)(shared_1.Permissions.CHANNEL_PARTNERS_CREATE), (0, validate_1.validateRequestBody)(shared_1.CPCreateSchema), async (req, res) => {
    try {
        const { firm_name, contact_name, phone, email, tier, upline_cp_id, rera_number, pan_number, bank_name, bank_account_number, bank_ifsc, } = req.body;
        const companyId = req.user?.companyId || req.user?.company_id || 1;
        const cpCode = await generateNextCPCode();
        const cp = await p.channelPartner.create({
            data: {
                cp_code: cpCode,
                company_id: companyId,
                firm_name,
                contact_name,
                phone,
                email: email || null,
                tier: tier || 'SILVER',
                upline_cp_id: upline_cp_id || null,
                rera_number: rera_number || null,
                pan_number: pan_number || null,
                bank_name: bank_name || null,
                bank_account_number: bank_account_number || null,
                bank_ifsc: bank_ifsc || null,
                status: 'ACTIVE',
            },
        });
        return res.status(201).json({
            message: `Channel Partner ${cp.cp_code} registered successfully under ${cp.tier} tier`,
            channelPartner: cp,
        });
    }
    catch (error) {
        console.error('Create CP error:', error);
        return res.status(500).json({ error: 'Failed to register channel partner' });
    }
});
// POST /api/v1/cp/calculate-commission - Calculate Hierarchical Commission (Level 1 & 2)
router.post('/calculate-commission', auth_1.authenticateToken, (0, authz_1.requireAuthz)(shared_1.Permissions.CHANNEL_PARTNERS_CALCULATE_COMMISSION), (0, validate_1.validateRequestBody)(shared_1.CPCommissionCalculateSchema), async (req, res) => {
    try {
        const { cp_id, deal_amount, property_id, lead_id } = req.body;
        const directCP = await p.channelPartner.findUnique({
            where: { id: cp_id },
            include: { upline_cp: true },
        });
        if (!directCP) {
            return res.status(404).json({ error: 'Channel Partner not found' });
        }
        if (!(0, authorization_1.can)(req.user, shared_1.Permissions.CHANNEL_PARTNERS_CALCULATE_COMMISSION, directCP)) {
            return res.status(403).json({ error: 'Forbidden: Cannot calculate commission for a Channel Partner outside your scope' });
        }
        const createdPayouts = [];
        // Level 1: Direct CP Commission
        const level1Rate = shared_1.CPTierRates[directCP.tier] || 2.0;
        const level1Amount = (deal_amount * level1Rate) / 100;
        const level1PayoutCode = await generateNextPayoutCode();
        const payout1 = await p.cPPayout.create({
            data: {
                payout_code: level1PayoutCode,
                cp_id: directCP.id,
                lead_id: lead_id || null,
                property_id: property_id || null,
                deal_amount,
                tier_rate_percent: level1Rate,
                commission_amount: level1Amount,
                level: 1,
                status: 'PENDING_MD_APPROVAL',
                notes: `Level 1 Direct Sale Commission (${directCP.tier} Tier @ ${level1Rate}%)`,
            },
        });
        createdPayouts.push(payout1);
        // Level 2: Upline CP Override Cut (if upline exists)
        if (directCP.upline_cp) {
            const level2Rate = shared_1.CPOverrideRate; // 0.5%
            const level2Amount = (deal_amount * level2Rate) / 100;
            const level2PayoutCode = await generateNextPayoutCode();
            const payout2 = await p.cPPayout.create({
                data: {
                    payout_code: level2PayoutCode,
                    cp_id: directCP.upline_cp.id,
                    lead_id: lead_id || null,
                    property_id: property_id || null,
                    deal_amount,
                    tier_rate_percent: level2Rate,
                    commission_amount: level2Amount,
                    level: 2,
                    status: 'PENDING_MD_APPROVAL',
                    notes: `Level 2 Upline Override Commission from ${directCP.firm_name} sale (${level2Rate}%)`,
                },
            });
            createdPayouts.push(payout2);
        }
        return res.status(200).json({
            message: `Hierarchical commission calculated: Level 1 (₹${level1Amount.toLocaleString()}) ${directCP.upline_cp ? `+ Level 2 Upline (₹${((deal_amount * shared_1.CPOverrideRate) / 100).toLocaleString()})` : ''}`,
            payouts: createdPayouts,
        });
    }
    catch (error) {
        console.error('Calculate commission error:', error);
        return res.status(500).json({ error: 'Failed to calculate commission' });
    }
});
// GET /api/v1/cp/payouts - Fetch Commission Payout Ledger
router.get('/payouts', auth_1.authenticateToken, async (req, res) => {
    try {
        const payouts = await p.cPPayout.findMany({
            where: { cp: { company_id: req.user.companyId } },
            include: {
                cp: { select: { id: true, cp_code: true, firm_name: true, contact_name: true, tier: true } },
                approved_by: { select: { id: true, employee_code: true, full_name: true } },
            },
            orderBy: { created_at: 'desc' },
        });
        return res.status(200).json({ payouts });
    }
    catch (error) {
        console.error('Fetch payouts error:', error);
        return res.status(500).json({ error: 'Failed to fetch payout ledger' });
    }
});
// POST /api/v1/cp/payouts/:id/approve - MD Approval / Disbursement for Commission Payout
router.post('/payouts/:id/approve', auth_1.authenticateToken, (0, authz_1.requireAuthz)(shared_1.Permissions.CHANNEL_PARTNERS_PAYOUTS_APPROVE), async (req, res) => {
    try {
        const payoutId = parseInt(req.params.id, 10);
        const employeeId = req.user?.employeeId || req.user?.userId || req.user?.id || 1;
        const payout = await p.cPPayout.findUnique({
            where: { id: payoutId },
            include: { cp: true }
        });
        if (!payout) {
            return res.status(404).json({ error: 'Payout record not found' });
        }
        if (!(0, authorization_1.can)(req.user, shared_1.Permissions.CHANNEL_PARTNERS_PAYOUTS_APPROVE, payout.cp)) {
            return res.status(403).json({ error: 'Forbidden: Cannot approve payout for a Channel Partner outside your scope' });
        }
        const updated = await p.cPPayout.update({
            where: { id: payoutId },
            data: {
                status: 'DISBURSED',
                approved_by_id: employeeId,
                approved_at: new Date(),
                disbursed_at: new Date(),
            },
        });
        return res.status(200).json({
            message: `Commission Payout ${payout.payout_code} (₹${payout.commission_amount.toLocaleString()}) APPROVED & DISBURSED by MD!`,
            payout: updated,
        });
    }
    catch (error) {
        console.error('Approve payout error:', error);
        return res.status(500).json({ error: 'Failed to approve payout' });
    }
});
// POST /api/v1/cp/protect-lead - Create a 90-day CP Protection Lock
router.post('/protect-lead', auth_1.authenticateToken, (0, auth_1.requireRole)([shared_1.Roles.CHANNEL_PARTNER]), // Only the CP themselves can claim protection (or you could expand it)
async (req, res) => {
    try {
        const { lead_id, cp_id } = req.body;
        const protectedUntil = new Date();
        protectedUntil.setDate(protectedUntil.getDate() + 60); // 60 days lock protection
        const lock = await p.leadProtectionLock.upsert({
            where: { lead_id },
            update: {
                cp_id,
                protected_until: protectedUntil,
                lock_status: 'ACTIVE',
            },
            create: {
                lead_id,
                cp_id,
                protected_until: protectedUntil,
                lock_status: 'ACTIVE',
            },
        });
        return res.status(200).json({
            message: '60-Day Anti-Poaching Protection Lock activated for lead until ' + protectedUntil.toLocaleDateString(),
            lock,
        });
    }
    catch (error) {
        console.error('Protect lead error:', error);
        return res.status(500).json({ error: 'Failed to activate lead protection lock' });
    }
});
exports.default = router;
