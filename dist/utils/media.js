"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.publicAssetUrl = void 0;
function publicAssetUrl(relativePath) {
    if (!relativePath)
        return null;
    if (/^https?:\/\//i.test(relativePath))
        return relativePath;
    const base = process.env.PUBLIC_API_URL || process.env.API_PUBLIC_URL || '';
    const cleanBase = base.replace(/\/$/, '');
    const cleanPath = relativePath.startsWith('/') ? relativePath : `/${relativePath}`;
    return `${cleanBase}${cleanPath}`;
}
exports.publicAssetUrl = publicAssetUrl;
