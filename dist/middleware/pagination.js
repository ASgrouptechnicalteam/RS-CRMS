"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.enforceMaxPagination = void 0;
const enforceMaxPagination = (req, res, next) => {
    if (req.method === 'GET' && req.query.limit) {
        const limit = parseInt(req.query.limit, 10);
        if (!isNaN(limit) && limit > 100) {
            req.query.limit = '100'; // Enforce maximum cap of 100
        }
    }
    next();
};
exports.enforceMaxPagination = enforceMaxPagination;
