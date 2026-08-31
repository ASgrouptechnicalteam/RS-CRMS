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

import { z } from 'zod';

export const PropertyCategory = z.enum([
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
export type PropertyCategoryValue = z.infer<typeof PropertyCategory>;

export const BrandType = z.enum(['SONTHILLU', 'RADHA_REAL_HOMES']);
export type BrandTypeValue = z.infer<typeof BrandType>;

export const ListingType = z.enum(['NEW', 'RESALE']);
export type ListingTypeValue = z.infer<typeof ListingType>;

export const PossessionStatus = z.enum(['READY_TO_MOVE', 'UNDER_CONSTRUCTION']);
export type PossessionStatusValue = z.infer<typeof PossessionStatus>;

export const Facing = z.enum(['EAST', 'WEST', 'NORTH', 'SOUTH', 'NORTH_EAST', 'SOUTH_EAST']);
export type FacingValue = z.infer<typeof Facing>;

/** Structured location — a best-effort extraction of the CRM location string. */
export const SearchIntentLocationSchema = z
  .object({
    state: z.string().min(1).max(80).optional(),
    city: z.string().min(1).max(80).optional(),
    locality: z.string().min(1).max(80).optional(),
    pincode: z.string().min(3).max(9).optional(),
  })
  .strict();

export const BudgetRangeSchema = z
  .object({
    min: z.number().finite().nonnegative().optional(),
    max: z.number().finite().positive().optional(),
  })
  .refine((b) => b.min === undefined || b.max === undefined || b.min <= b.max, {
    message: 'budget.min must be no greater than budget.max',
    path: ['budget'],
  });

export const BedroomsRangeSchema = z.object({
  min: z.number().int().positive().optional(),
});

export const BathroomsRangeSchema = z.object({
  min: z.number().int().positive().optional(),
});

export const AreaRangeSchema = z
  .object({
    min: z.number().finite().positive().optional(),
    max: z.number().finite().positive().optional(),
  })
  .refine((a) => a.min === undefined || a.max === undefined || a.min <= a.max, {
    message: 'area.min must be no greater than area.max',
    path: ['area'],
  });
/** Verified property-search criteria. Every field maps to a real CRM filter. */
export const SearchIntentSchema = z
  .object({
    propertyType: PropertyCategory.optional(),
    brandType: BrandType.optional(),
    location: SearchIntentLocationSchema.optional(),
    budget: BudgetRangeSchema.optional(),
    bhk: BedroomsRangeSchema.optional(),
    bathrooms: BathroomsRangeSchema.optional(),
    area: AreaRangeSchema.optional(),
    facing: Facing.optional(),
    listingType: ListingType.optional(),
    possessionStatus: PossessionStatus.optional(),
    /**
     * Requested criteria with no verified CRM representation (e.g. a structured amenity
     * filter). Carried so the website can inform the user, never invented as a DB field.
     */
    unsupportedCriteria: z.array(z.string().min(1)).max(8).optional(),
  })
  .strict();

export type SearchIntent = z.infer<typeof SearchIntentSchema>;

export const AmbiguitySchema = z
  .object({
    field: z.string().min(1).max(80),
    candidates: z.array(z.string().min(1)).min(1).max(20),
  })
  .strict();

export type SearchIntentAmbiguity = z.infer<typeof AmbiguitySchema>;

/**
 * Machine-readable result of AI search-intent extraction. AI never answers conversationally
 * and never recommends/ranks properties.
 *   - COMPLETE   -> carries an actionable SearchIntent for CRM to filter.
 *   - INCOMPLETE -> carries missingRequirements / ambiguities and `nextAction: AI_CHAT`.
 */
export const SearchIntentExtractionSchema = z
  .object({
    status: z.enum(['COMPLETE', 'INCOMPLETE']),
    searchIntent: SearchIntentSchema.optional(),
    missingRequirements: z.array(z.string().min(1)).max(16).optional(),
    ambiguities: z.array(AmbiguitySchema).max(8).optional(),
    unsupportedCriteria: z.array(z.string().min(1)).max(8).optional(),
    nextAction: z.enum(['AI_CHAT']).default('AI_CHAT'),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.status === 'COMPLETE' && !val.searchIntent) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'COMPLETE extraction requires a searchIntent',
        path: ['searchIntent'],
      });
    }
    if (val.status === 'INCOMPLETE' && val.searchIntent) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'INCOMPLETE extraction must not carry a searchIntent',
        path: ['searchIntent'],
      });
    }
  });

export type SearchIntentExtraction = z.infer<typeof SearchIntentExtractionSchema>;

export type SearchIntentStatus = SearchIntentExtraction['status'];

/** Thrown when structured AI output fails deterministic validation. */
export class InvalidSearchIntentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSearchIntentError';
  }
}

/** Deterministic validation. Malformed structured output is rejected before it can enter CRM logic. */
export function validateSearchIntentExtraction(raw: any): SearchIntentExtraction {
  const parsed = SearchIntentExtractionSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new InvalidSearchIntentError(`Invalid SearchIntent extraction: ${detail}`);
  }
  return parsed.data;
}

/** Validate a bare SearchIntent body (for callers that already know it is COMPLETE). */
export function validateSearchIntent(raw: any): SearchIntent {
  const parsed = SearchIntentSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new InvalidSearchIntentError(`Invalid SearchIntent: ${detail}`);
  }
  return parsed.data;
}
