"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const logger_1 = require("../utils/logger");
const express_1 = require("express");
const prisma_1 = require("../lib/prisma");
const router = (0, express_1.Router)();
router.get('/', async (req, res) => {
    try {
        // Attempt to run a simple query to verify DB connection
        await prisma_1.prisma.$queryRaw `SELECT 1`;
        res.status(200).json({ status: 'OK', database: 'connected', timestamp: new Date().toISOString() });
    }
    catch (error) {
        logger_1.logger.error('Database connection failed:', error);
        res.status(503).json({ status: 'ERROR', database: 'disconnected', timestamp: new Date().toISOString() });
    }
});
exports.default = router;
