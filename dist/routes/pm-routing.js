"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const pm_routing_service_1 = require("../services/pm-routing.service");
const shared_1 = require("../shared");
const router = (0, express_1.Router)();
router.use(auth_1.authenticateToken);
// Middleware to ensure user is MD or Admin
const requireAdminOrMD = (req, res, next) => {
    const roles = req.user?.roles || [];
    if (!roles.includes(shared_1.Roles.MD) && !roles.includes(shared_1.Roles.ADMIN)) {
        return next(new pm_routing_service_1.AppError(403, 'Forbidden: Only MD or Admin can manage PM locations'));
    }
    next();
};
router.use(requireAdminOrMD);
router.get('/', async (req, res, next) => {
    try {
        const assignments = await pm_routing_service_1.PMRoutingService.getAssignments(req.user.companyId || 1);
        res.json(assignments);
    }
    catch (error) {
        next(error);
    }
});
router.post('/', async (req, res, next) => {
    try {
        const { pm_id, location, level } = req.body;
        if (!pm_id || !location) {
            throw new pm_routing_service_1.AppError(400, 'pm_id and location are required');
        }
        const assignment = await pm_routing_service_1.PMRoutingService.assignLocation(req.user.companyId || 1, pm_id, location, level);
        res.status(201).json(assignment);
    }
    catch (error) {
        next(error);
    }
});
router.delete('/:id', async (req, res, next) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id))
            throw new pm_routing_service_1.AppError(400, 'Invalid ID');
        const result = await pm_routing_service_1.PMRoutingService.removeAssignment(req.user.companyId || 1, id);
        res.json(result);
    }
    catch (error) {
        next(error);
    }
});
exports.default = router;
