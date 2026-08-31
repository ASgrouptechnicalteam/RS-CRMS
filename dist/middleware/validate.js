"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateRequestBody = void 0;
const zod_1 = require("zod");
const validateRequestBody = (schema) => {
    return (req, res, next) => {
        try {
            req.body = schema.parse(req.body);
            next();
        }
        catch (error) {
            if (error instanceof zod_1.ZodError) {
                const errorMessages = error.errors.map(err => {
                    const path = err.path.join('.');
                    return path ? `${path}: ${err.message}` : err.message;
                }).join(', ');
                return res.status(400).json({
                    error: errorMessages, // Provide explicit, readable validation message instead of generic 'Validation Error'
                    details: error.errors.map((err) => ({
                        field: err.path.join('.'),
                        message: err.message,
                    })),
                });
            }
            next(error);
        }
    };
};
exports.validateRequestBody = validateRequestBody;
