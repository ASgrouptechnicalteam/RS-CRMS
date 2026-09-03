"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.logger = void 0;
const pino_1 = __importDefault(require("pino"));
const pinoLogger = (0, pino_1.default)({
    level: process.env.LOG_LEVEL || 'info',
    formatters: {
        level: (label) => {
            return { level: label.toUpperCase() };
        },
    },
    timestamp: pino_1.default.stdTimeFunctions.isoTime,
});
exports.logger = {
    info: (...args) => {
        if (args.length === 2 && typeof args[0] === 'string') {
            pinoLogger.info({ data: args[1] }, args[0]);
        }
        else {
            pinoLogger.info(args.length === 1 ? args[0] : args);
        }
    },
    error: (...args) => {
        if (args.length === 2 && typeof args[0] === 'string') {
            pinoLogger.error({ err: args[1] }, args[0]);
        }
        else {
            pinoLogger.error(args.length === 1 ? args[0] : args);
        }
    },
    warn: (...args) => {
        if (args.length === 2 && typeof args[0] === 'string') {
            pinoLogger.warn({ data: args[1] }, args[0]);
        }
        else {
            pinoLogger.warn(args.length === 1 ? args[0] : args);
        }
    }
};
