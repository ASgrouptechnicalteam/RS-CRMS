"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.correlationId = void 0;
const crypto_1 = require("crypto");
const correlationId = (req, res, next) => {
    const incoming = req.header('x-request-id');
    const id = incoming && incoming.length <= 64 ? incoming : (0, crypto_1.randomUUID)();
    req.requestId = id;
    res.setHeader('X-Request-Id', id);
    next();
};
exports.correlationId = correlationId;
