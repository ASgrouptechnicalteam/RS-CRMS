"use strict";
/**
 * Phase 17-A — SearchIntent contract.
 *
 * The structured outcome of AI understanding a user's natural-language property search.
 * It carries NO match percentage, NO ranking, NO purchase-suitability decision, and NO
 * property recommendation — those are CRM responsibilities and remain deterministic.
 *
 * The contract is deliberately limited to property attributes the CURRENT CRM/Property
 * domain can actually filter on, verified against:
 *   - `prisma/schema.prisma` Property model
 *   - the public property-search route (`apps/api/src/routes/public.ts`)
 *   - `packages/shared` PropertyCreateSchema
 *
 * DELIBERATELY EXCLUDED (no verified CRM structure / internal concern):
 *   - amenities  : unstructured text blob on Property -> surfaced via `unsupportedCriteria`
 *   - GPS/coords : internal only on Property
 *   - status     : internal CRM workflow / availability authority; never a user filter
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateSearchIntent = exports.validateSearchIntentExtraction = exports.InvalidSearchIntentError = exports.SearchIntentExtractionSchema = exports.AmbiguitySchema = exports.SearchIntentSchema = exports.AreaRangeSchema = exports.BathroomsRangeSchema = exports.BedroomsRangeSchema = exports.BudgetRangeSchema = exports.SearchIntentLocationSchema = exports.Facing = exports.PossessionStatus = exports.ListingType = exports.BrandType = exports.PropertyCategory = void 0;
const zod_1 = require("zod");
exports.PropertyCategory = zod_1.z.enum([
    'APARTMENT',
    'INDEPENDENT_HOUSE',
    'DUPLEX',
    'INDEPENDENT_FLOOR',
    'VILLA',
    'PENTHOUSE',
    'STUDIO',
    'PLOT',
    'FARM_HOUSE',
    'AGRICULTURAL_LAND',
]);
exports.BrandType = zod_1.z.enum(['SONTHILLU', 'RADHA_REAL_HOMES']);
exports.ListingType = zod_1.z.enum(['NEW', 'RESALE']);
exports.PossessionStatus = zod_1.z.enum(['READY_TO_MOVE', 'UNDER_CONSTRUCTION']);
exports.Facing = zod_1.z.enum(['EAST', 'WEST', 'NORTH', 'SOUTH', 'NORTH_EAST', 'SOUTH_EAST']);
/** Structured location — a best-effort extraction of the CRM location string. */
exports.SearchIntentLocationSchema = zod_1.z
    .object({
    state: zod_1.z.string().min(1).max(80).optional(),
    city: zod_1.z.string().min(1).max(80).optional(),
    locality: zod_1.z.string().min(1).max(80).optional(),
    pincode: zod_1.z.string().min(3).max(9).optional(),
})
    .strict();
exports.BudgetRangeSchema = zod_1.z
    .object({
    min: zod_1.z.number().finite().nonnegative().optional(),
    max: zod_1.z.number().finite().positive().optional(),
})
    .refine((b) => b.min === undefined || b.max === undefined || b.min <= b.max, {
    message: 'budget.min must be no greater than budget.max',
    path: ['budget'],
});
exports.BedroomsRangeSchema = zod_1.z.object({
    min: zod_1.z.number().int().positive().optional(),
});
exports.BathroomsRangeSchema = zod_1.z.object({
    min: zod_1.z.number().int().positive().optional(),
});
exports.AreaRangeSchema = zod_1.z
    .object({
    min: zod_1.z.number().finite().positive().optional(),
    max: zod_1.z.number().finite().positive().optional(),
})
    .refine((a) => a.min === undefined || a.max === undefined || a.min <= a.max, {
    message: 'area.min must be no greater than area.max',
    path: ['area'],
});
/** Verified property-search criteria. Every field maps to a real CRM filter. */
exports.SearchIntentSchema = zod_1.z
    .object({
    propertyType: exports.PropertyCategory.optional(),
    brandType: exports.BrandType.optional(),
    location: exports.SearchIntentLocationSchema.optional(),
    budget: exports.BudgetRangeSchema.optional(),
    bhk: exports.BedroomsRangeSchema.optional(),
    bathrooms: exports.BathroomsRangeSchema.optional(),
    area: exports.AreaRangeSchema.optional(),
    facing: exports.Facing.optional(),
    listingType: exports.ListingType.optional(),
    possessionStatus: exports.PossessionStatus.optional(),
    /**
     * Requested criteria with no verified CRM representation (e.g. a structured amenity
     * filter). Carried so the website can inform the user, never invented as a DB field.
     */
    unsupportedCriteria: zod_1.z.array(zod_1.z.string().min(1)).max(8).optional(),
})
    .strict();
exports.AmbiguitySchema = zod_1.z
    .object({
    field: zod_1.z.string().min(1).max(80),
    candidates: zod_1.z.array(zod_1.z.string().min(1)).min(1).max(20),
})
    .strict();
/**
 * Machine-readable result of AI search-intent extraction. AI never answers conversationally
 * and never recommends/ranks properties.
 *   - COMPLETE   -> carries an actionable SearchIntent for CRM to filter.
 *   - INCOMPLETE -> carries missingRequirements / ambiguities and `nextAction: AI_CHAT`.
 */
exports.SearchIntentExtractionSchema = zod_1.z
    .object({
    status: zod_1.z.enum(['COMPLETE', 'INCOMPLETE']),
    searchIntent: exports.SearchIntentSchema.optional(),
    missingRequirements: zod_1.z.array(zod_1.z.string().min(1)).max(16).optional(),
    ambiguities: zod_1.z.array(exports.AmbiguitySchema).max(8).optional(),
    unsupportedCriteria: zod_1.z.array(zod_1.z.string().min(1)).max(8).optional(),
    nextAction: zod_1.z.enum(['AI_CHAT']).default('AI_CHAT'),
})
    .strict()
    .superRefine((val, ctx) => {
    if (val.status === 'COMPLETE' && !val.searchIntent) {
        ctx.addIssue({
            code: zod_1.z.ZodIssueCode.custom,
            message: 'COMPLETE extraction requires a searchIntent',
            path: ['searchIntent'],
        });
    }
    if (val.status === 'INCOMPLETE' && val.searchIntent) {
        ctx.addIssue({
            code: zod_1.z.ZodIssueCode.custom,
            message: 'INCOMPLETE extraction must not carry a searchIntent',
            path: ['searchIntent'],
        });
    }
});
/** Thrown when structured AI output fails deterministic validation. */
class InvalidSearchIntentError extends Error {
    constructor(message) {
        super(message);
        this.name = 'InvalidSearchIntentError';
    }
}
exports.InvalidSearchIntentError = InvalidSearchIntentError;
/** Deterministic validation. Malformed structured output is rejected before it can enter CRM logic. */
function validateSearchIntentExtraction(raw) {
    const parsed = exports.SearchIntentExtractionSchema.safeParse(raw);
    if (!parsed.success) {
        const detail = parsed.error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; ');
        throw new InvalidSearchIntentError(`Invalid SearchIntent extraction: ${detail}`);
    }
    return parsed.data;
}
exports.validateSearchIntentExtraction = validateSearchIntentExtraction;
/** Validate a bare SearchIntent body (for callers that already know it is COMPLETE). */
function validateSearchIntent(raw) {
    const parsed = exports.SearchIntentSchema.safeParse(raw);
    if (!parsed.success) {
        const detail = parsed.error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; ');
        throw new InvalidSearchIntentError(`Invalid SearchIntent: ${detail}`);
    }
    return parsed.data;
}
exports.validateSearchIntent = validateSearchIntent;
