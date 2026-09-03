"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyQrHmac = exports.generateQrHmac = void 0;
const crypto_1 = __importDefault(require("crypto"));
const QR_HMAC_SECRET = process.env.QR_HMAC_SECRET;
if (!QR_HMAC_SECRET) {
    throw new Error('QR_HMAC_SECRET is not configured');
}
const generateQrHmac = (employeeId, employeeCode, version = 1) => {
    const data = `${employeeId}:${employeeCode}:${version}`;
    return crypto_1.default.createHmac('sha256', QR_HMAC_SECRET).update(data).digest('hex');
};
exports.generateQrHmac = generateQrHmac;
const verifyQrHmac = (employeeId, employeeCode, version, signature) => {
    if (!signature)
        return false;
    const expected = (0, exports.generateQrHmac)(employeeId, employeeCode, version);
    return crypto_1.default.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
};
exports.verifyQrHmac = verifyQrHmac;
