"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateUniqueSlug = exports.slugify = void 0;
function slugify(input) {
    if (!input || !input.trim()) {
        return '';
    }
    return input
        .toLowerCase()
        .trim()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\w\s-]/g, '')
        .replace(/[\s_-]+/g, '-')
        .replace(/^-+|-+$/g, '');
}
exports.slugify = slugify;
async function generateUniqueSlug(baseSlug, companyId, checkExists) {
    if (!baseSlug) {
        return '';
    }
    let slug = baseSlug;
    let counter = 0;
    while (await checkExists(slug, companyId)) {
        counter++;
        slug = `${baseSlug}-${counter}`;
    }
    return slug;
}
exports.generateUniqueSlug = generateUniqueSlug;
