import { z } from 'zod';
import { BasePropertyCreateSchema } from './property';
import { ProjectTypeEnum } from './project';
import { checkListingDetails } from './listingFields';

// DraftSubmission "lite" fields (docs/plans/rbac-plan.md section 3.3).
// The enums are taken from the real create schemas so a draft can never hold a
// brand, category or project type the real record would reject.
//
// Keep this file identical in apps/api/src/shared/draft.ts and
// packages/shared/src/draft.ts.

export const DRAFT_TYPES = ['PROPERTY', 'PROJECT'] as const;
export const DRAFT_STATUSES = ['SUBMITTED', 'IN_PROGRESS', 'NEEDS_INFO', 'READY_IN_CRM'] as const;
export const DRAFT_ATTACHMENT_KINDS = ['PHOTO', 'VIDEO', 'PRICE_SHEET', 'DOCUMENT'] as const;
export type DraftType = (typeof DRAFT_TYPES)[number];
export type DraftStatusValue = (typeof DRAFT_STATUSES)[number];
export type DraftAttachmentKindValue = (typeof DRAFT_ATTACHMENT_KINDS)[number];

const text = (min: number, max = 255) => z.string().trim().min(min).max(max);
const optText = (max = 255) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));
const optNum = z.number().positive().optional().nullable();

// Indian mobile / landline, digits with an optional +91 prefix; same loose
// shape the rest of the CRM accepts for a phone typed by hand.
const phone = z
  .string()
  .trim()
  .regex(/^\+?[0-9][0-9 -]{6,17}$/, 'Enter a valid phone number')
  .max(20);

const ProjectTypeValue = ProjectTypeEnum;
const BrandValue = BasePropertyCreateSchema.shape.brand_type;
const CategoryValue = BasePropertyCreateSchema.shape.category;

// The per-type details (sq yd for a plot, acres for farm land, BHK for a
// flat...) travel in `details` and are checked against listingFields.ts.
const details = z.record(z.unknown()).optional().nullable();

const ProjectDraftFields = z.object({
  type: z.literal('PROJECT'),
  // mandatory
  title: text(3), // the project name
  location: text(3),
  city: text(2, 120),
  project_type: ProjectTypeValue,
  developer_name: text(2),
  // The contactable person (team only, never public). Required by the CRM form, optional here for other senders.
  owner_contact_name: optText(255),
  owner_contact_phone: phone.optional().nullable(),
  // optional
  maps_link: optText(500),
  rera_number: optText(100),
  launch_date: optText(40),
  description: optText(4000),
  details,
});

const PropertyDraftFields = z.object({
  type: z.literal('PROPERTY'),
  // mandatory
  title: text(3),
  category: CategoryValue,
  location: text(2),
  city: text(2, 120),
  // optional. Derived from the category when left out (commercial is Radha
  // Real Homes, everything else Sonthillu), the same rule as the property form.
  brand_type: BrandValue.optional(),
  listing_type: z.enum(['NEW', 'RESALE']).optional().nullable(),
  maps_link: optText(500),
  project_name_hint: optText(255),
  description: optText(4000),
  // The contactable person (owner, developer or site contact): team only, never public.
  owner_contact_name: optText(255),
  owner_contact_phone: phone.optional().nullable(),
  details,
});

const checkDetails =
  (type: 'PROPERTY' | 'PROJECT') => (data: Record<string, any>, ctx: z.RefinementCtx) => {
    const kindValue = type === 'PROPERTY' ? data.category : data.project_type;
    if (!kindValue) return;
    const { problems } = checkListingDetails(type, kindValue, data.details || {});
    for (const message of problems) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['details'], message });
    }
  };

export const ProjectDraftCreateSchema = ProjectDraftFields.superRefine(checkDetails('PROJECT'));
export const PropertyDraftCreateSchema = PropertyDraftFields.superRefine(checkDetails('PROPERTY'));

export const DraftCreateSchema = z.union([ProjectDraftCreateSchema, PropertyDraftCreateSchema]);

// Edit keeps the listing's type: the same fields, every one optional. The
// details are checked again in DraftService.update against the saved type.
export const ProjectDraftUpdateSchema = ProjectDraftFields.omit({ type: true }).partial();
export const PropertyDraftUpdateSchema = PropertyDraftFields.omit({ type: true }).partial();

export const DraftNeedsInfoSchema = z.object({
  note: z.string().trim().min(3, 'Say what is missing').max(1000),
});

export const DraftLinkSchema = z.object({
  record_id: z.number().int().positive(),
});

/** "Already in CRM": naming the record is optional. */
export const DraftAlreadyInCrmSchema = z.object({
  record_id: z.number().int().positive().optional().nullable(),
});

export const DraftReplySchema = z.object({
  note: z.string().trim().max(1000).optional(),
});

export type DraftCreateInput = z.infer<typeof DraftCreateSchema>;
export type ProjectDraftCreateInput = z.infer<typeof ProjectDraftCreateSchema>;
export type PropertyDraftCreateInput = z.infer<typeof PropertyDraftCreateSchema>;
