"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const prisma_1 = require("../lib/prisma");
const auth_1 = require("../middleware/auth");
const authz_1 = require("../middleware/authz");
const shared_1 = require("../shared");
const router = (0, express_1.Router)();
// GET /api/v1/roles - List all roles (used by Role Assignment Page)
router.get('/', auth_1.authenticateToken, (0, authz_1.requireAuthz)(shared_1.Permissions.EMPLOYEES_READ), async (req, res) => {
    try {
        const roles = await prisma_1.prisma.role.findMany({
            orderBy: { name: 'asc' },
        });
        return res.status(200).json({ roles });
    }
    catch (error) {
        return res.status(500).json({ error: 'Failed to fetch roles' });
    }
});
exports.default = router;
