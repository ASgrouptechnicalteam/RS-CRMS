"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchWithCache = exports.clearCache = exports.cache = void 0;
const node_cache_1 = __importDefault(require("node-cache"));
const logger_1 = require("./logger");
// Standard TTL of 5 minutes, checking for expired keys every 1 minute
exports.cache = new node_cache_1.default({ stdTTL: 300, checkperiod: 60 });
const clearCache = () => {
    const stats = exports.cache.getStats();
    exports.cache.flushAll();
    logger_1.logger.info(`[Cache] Flushed ${stats.keys} keys from memory.`);
    return stats;
};
exports.clearCache = clearCache;
// Example utility to wrap fetching data with cache
const fetchWithCache = async (key, fetchFn, ttlSeconds) => {
    const cached = exports.cache.get(key);
    if (cached) {
        logger_1.logger.info(`[Cache] HIT for key: ${key}`);
        return cached;
    }
    logger_1.logger.info(`[Cache] MISS for key: ${key}. Fetching...`);
    const data = await fetchFn();
    exports.cache.set(key, data, ttlSeconds || 300);
    return data;
};
exports.fetchWithCache = fetchWithCache;
