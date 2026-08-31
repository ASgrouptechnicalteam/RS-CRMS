"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const prisma_1 = require("../lib/prisma");
const auth_1 = require("../middleware/auth");
const shared_1 = require("../shared");
const router = (0, express_1.Router)();
const p = prisma_1.prisma;
// GET /api/v1/announcement
// Publicly fetch the active announcement for the company
router.get('/', async (req, res) => {
    try {
        const company = await p.company.findUnique({
            where: { code: 'RRH' },
            select: {
                announcement_image_url: true,
                announcement_active: true,
            }
        });
        if (!company) {
            return res.status(404).json({ error: 'Company not found' });
        }
        return res.json({
            imageUrl: company.announcement_image_url,
            active: company.announcement_active
        });
    }
    catch (error) {
        console.error('Error fetching announcement:', error);
        return res.status(500).json({ error: 'Failed to fetch announcement' });
    }
});
// POST /api/v1/announcement
// MD and Admin can update the announcement banner
router.post('/', auth_1.authenticateToken, async (req, res) => {
    try {
        const userRoles = req.user.roles;
        if (!userRoles.includes(shared_1.Roles.MD) && !userRoles.includes(shared_1.Roles.ADMIN)) {
            return res.status(403).json({ error: 'Only MD and Admin can update announcements' });
        }
        const { imageUrl, active } = req.body;
        const updatedCompany = await p.company.update({
            where: { id: req.user.companyId },
            data: {
                announcement_image_url: imageUrl,
                announcement_active: active,
            },
        });
        return res.json({
            message: 'Announcement banner updated successfully',
            imageUrl: updatedCompany.announcement_image_url,
            active: updatedCompany.announcement_active,
        });
    }
    catch (error) {
        console.error('Error updating announcement:', error);
        return res.status(500).json({ error: 'Failed to update announcement' });
    }
});
exports.default = router;
