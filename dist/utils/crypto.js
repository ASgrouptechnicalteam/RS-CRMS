"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.decryptData = exports.encryptData = void 0;
const logger_1 = require("./logger");
const crypto_1 = __importDefault(require("crypto"));
// Production REQUIRES a real ENCRYPTION_KEY (>= 32 chars) — the dev fallback is
// only for development/test and is never used in production (Phase 11 Packet 3C).
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || (process.env.NODE_ENV === 'production' ? '' : 'default_32_byte_secret_key_change_me_now!');
const IV_LENGTH = 16; // For AES, this is always 16
function encryptData(text) {
    if (!text)
        return null;
    // Create a 32-byte key from the env variable (pad or truncate if necessary)
    const key = crypto_1.default.createHash('sha256').update(String(ENCRYPTION_KEY)).digest('base64').substring(0, 32);
    const iv = crypto_1.default.randomBytes(IV_LENGTH);
    const cipher = crypto_1.default.createCipheriv('aes-256-cbc', Buffer.from(key), iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
}
exports.encryptData = encryptData;
function decryptData(text) {
    if (!text)
        return null;
    try {
        const key = crypto_1.default.createHash('sha256').update(String(ENCRYPTION_KEY)).digest('base64').substring(0, 32);
        const textParts = text.split(':');
        const iv = Buffer.from(textParts.shift(), 'hex');
        const encryptedText = Buffer.from(textParts.join(':'), 'hex');
        const decipher = crypto_1.default.createDecipheriv('aes-256-cbc', Buffer.from(key), iv);
        let decrypted = decipher.update(encryptedText);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        return decrypted.toString();
    }
    catch (error) {
        logger_1.logger.error('Decryption failed, returning null or masked data', error);
        return null; // Return null if decryption fails so we don't break the app
    }
}
exports.decryptData = decryptData;
