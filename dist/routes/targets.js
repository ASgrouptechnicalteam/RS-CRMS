"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const prisma_1 = require("../lib/prisma");
const auth_1 = require("../middleware/auth");
const validate_1 = require("../middleware/validate");
const shared_1 = require("../shared");
const authz_1 = require("../middleware/authz");
const authorization_1 = require("../authz/authorization");
const hierarchy_1 = require("../utils/hierarchy");
const router = (0, express_1.Router)();
const p = prisma_1.prisma;
// Helper to generate basic schema for roles
const generateBasicSchema = (metrics, hasChecklist = false) => {
    const schema = metrics.map((m) => ({
        id: m,
        label: m.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase()),
        type: 'COUNT',
        required: true,
        targetValue: 0, // Will be overridden manually by MD, but provides structure
    }));
    if (hasChecklist) {
        schema.push({
            id: 'dailyTaskListCompleted',
            label: 'Daily Task List Completed',
            type: 'CHECKLIST',
            required: true
        });
        schema.push({
            id: 'endOfDayCleanup',
            label: 'End Of Day Cleanup',
            type: 'CHECKLIST',
            required: true
        });
    }
    schema.push({
        id: 'feedback',
        label: 'Daily Feedback & Notes',
        type: 'LONG_TEXT',
        required: false
    });
    return schema;
};
// Standard 1-Click Role Presets (Saving MD & Marketing Director time)
const ROLE_PRESETS = {
    [shared_1.Roles.TELECALLER]: {
        target_type: 'COUNT',
        targets_json: { callsMade: 50, leadsQualified: 5, followupsDone: 15 },
        form_schema_json: generateBasicSchema(['callsMade', 'leadsQualified', 'followupsDone'])
    },
    [shared_1.Roles.PROJECT_MANAGER]: {
        target_type: 'COUNT',
        targets_json: { siteVisits: 3, propertyVerifications: 2 },
        form_schema_json: generateBasicSchema(['siteVisits', 'propertyVerifications'])
    },
    [shared_1.Roles.DIGITAL_LEAD_OPERATOR]: {
        target_type: 'COUNT',
        targets_json: { leadsProcessed: 100, telecallerAssignments: 5 },
        form_schema_json: generateBasicSchema(['leadsProcessed', 'telecallerAssignments'])
    },
    [shared_1.Roles.DIGITAL_MARKETING_HEAD]: {
        target_type: 'COUNT',
        targets_json: { adSpendMonitored: 1, contentPosts: 3, leadsGenerated: 20 },
        form_schema_json: generateBasicSchema(['adSpendMonitored', 'contentPosts', 'leadsGenerated'])
    },
    [shared_1.Roles.HR_MANAGER]: {
        target_type: 'COUNT',
        targets_json: { interviewsConducted: 5, attendanceQueueCleared: 1 },
        form_schema_json: generateBasicSchema(['interviewsConducted', 'attendanceQueueCleared'])
    },
    [shared_1.Roles.FINANCE]: {
        target_type: 'COUNT',
        targets_json: { invoicesProcessed: 10, paymentAudits: 1 },
        form_schema_json: generateBasicSchema(['invoicesProcessed', 'paymentAudits'])
    },
};
// GET /api/v1/targets/presets - Get 1-click default preset suggestions
router.get('/presets', auth_1.authenticateToken, async (req, res) => {
    return res.status(200).json({ presets: ROLE_PRESETS });
});
// GET /api/v1/targets/my-target - Effective target resolution with Priority Hierarchy
router.get('/my-target', auth_1.authenticateToken, async (req, res) => {
    try {
        const employeeId = req.user.employeeId;
        const roleName = req.user.roles[0];
        // Priority 1: Employee-Specific Target (if active)
        let empTarget = null;
        if (p.dailyTarget) {
            empTarget = await p.dailyTarget.findFirst({
                where: {
                    employee_id: employeeId,
                    company_id: req.user.companyId,
                },
                orderBy: { created_at: 'desc' },
            });
        }
        if (empTarget) {
            return res.status(200).json({
                source: 'EMPLOYEE_SPECIFIC',
                target: empTarget,
            });
        }
        // Priority 2: Active Role-Based Target
        let roleTarget = null;
        if (p.dailyTarget) {
            roleTarget = await p.dailyTarget.findFirst({
                where: {
                    role_name: roleName,
                    employee_id: null,
                    company_id: req.user.companyId,
                },
                orderBy: { created_at: 'desc' },
            });
        }
        if (roleTarget) {
            return res.status(200).json({
                source: 'ROLE_BASED',
                target: roleTarget,
            });
        }
        // Priority 3: System Default Preset Fallback
        const preset = ROLE_PRESETS[roleName] || {
            target_type: 'COUNT',
            targets_json: {},
            form_schema_json: generateBasicSchema([])
        };
        return res.status(200).json({
            source: 'SYSTEM_PRESET',
            target: {
                role_name: roleName || 'UNKNOWN',
                target_type: preset.target_type,
                targets_json: preset.targets_json,
                form_schema_json: preset.form_schema_json,
            },
        });
    }
    catch (error) {
        console.error('Fetch my-target error:', error);
        return res.status(500).json({ error: 'Failed to resolve active target' });
    }
});
// GET /api/v1/targets/all - List all targets (MD & Marketing Director view)
router.get('/all', auth_1.authenticateToken, async (req, res) => {
    try {
        const roles = req.user.roles;
        if (!roles.includes(shared_1.Roles.MD) && !roles.includes(shared_1.Roles.MARKETING_DIRECTOR) && !roles.includes(shared_1.Roles.ADMIN)) {
            return res.status(403).json({ error: 'Access denied: MD or Marketing Director permission required.' });
        }
        let targets = [];
        if (p.dailyTarget) {
            targets = await p.dailyTarget.findMany({
                where: { company_id: req.user.companyId },
                include: { employee: true },
                orderBy: { created_at: 'desc' },
            });
        }
        return res.status(200).json({ targets });
    }
    catch (error) {
        return res.status(500).json({ error: 'Failed to fetch targets' });
    }
});
// POST /api/v1/targets - Set/Update Target (MD & Marketing Director)
router.post('/', auth_1.authenticateToken, (0, authz_1.requireAuthz)(shared_1.Permissions.REPORTS_TARGETS_CONFIGURE), (0, validate_1.validateRequestBody)(shared_1.DailyTargetSetSchema), async (req, res) => {
    try {
        const { role_name, employee_id, target_type, targets_json, form_schema_json } = req.body;
        const creatorId = req.user.employeeId;
        if (employee_id) {
            const targetEmployee = await p.employee.findUnique({
                where: { id: employee_id }
            });
            if (!targetEmployee) {
                return res.status(404).json({ error: 'Target employee not found' });
            }
            if (!(0, authorization_1.can)(req.user, shared_1.Permissions.REPORTS_TARGETS_CONFIGURE, targetEmployee)) {
                return res.status(403).json({ error: 'Forbidden: Cannot configure targets for this employee' });
            }
            const downstreamIds = await (0, hierarchy_1.getDownstreamEmployeeIds)(req.user.companyId, req.user.employeeId);
            const isMDOrAdmin = req.user.roles.some((r) => [shared_1.Roles.MD, shared_1.Roles.ADMIN].includes(r));
            if (!isMDOrAdmin && !downstreamIds.includes(employee_id)) {
                return res.status(403).json({ error: 'Forbidden: Employee is not within your reporting hierarchy' });
            }
        }
        let newTarget = null;
        if (p.dailyTarget) {
            newTarget = await p.dailyTarget.create({
                data: {
                    company_id: req.user.companyId,
                    role_name,
                    employee_id: employee_id || null,
                    calls_target: targets_json?.callsMade || 50,
                    site_visits_target: targets_json?.siteVisits || 3,
                    closed_deals_target: targets_json?.closedDeals || 1,
                    form_schema_json: form_schema_json || null,
                },
            });
        }
        // Write Audit Event
        await p.auditEvent.create({
            data: {
                actor_id: creatorId,
                action: 'SET_DAILY_TARGET',
                entity_type: 'DAILY_TARGET',
                entity_id: newTarget?.id || 1,
                new_value: JSON.stringify({ role_name, employee_id, target_type, targets_json }),
            },
        });
        return res.status(201).json({ message: 'Daily target set successfully', target: newTarget });
    }
    catch (error) {
        console.error('Set target error:', error);
        return res.status(500).json({ error: 'Failed to set target' });
    }
});
exports.default = router;
