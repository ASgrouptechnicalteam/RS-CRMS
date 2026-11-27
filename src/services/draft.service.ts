import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { TokenPayload } from '../utils/jwt';
import { logger } from '../utils/logger';
import { notifyEmployee } from '../utils/notifyEmployee';
import { getAccessibleCompanyIds } from '../authz/dataScope';
import { hasEffectivePermission } from '../middleware/authz';
import {
  DraftCreateInput,
  Permissions,
  ProjectDraftUpdateSchema,
  PropertyDraftUpdateSchema,
  Roles,
  checkListingDetails,
  listingAreaSqft,
} from '../shared';
import {
  DRAFT_ATTACHMENT_MAX_PER_DRAFT,
  DRAFT_VIDEO_MAX_PER_DRAFT,
  getDraftStorage,
  prepareDraftFile,
  signMediaToken,
} from './draftStorage';
import { projectFill, propertyFill } from './listingFill';
import { invalidateProjectListCache } from './project.service';

const p = prisma;

// Who reads the "new draft" notification: the digital team (same idea as the
// project review notice in project.service.ts), MD if nobody holds the roles.
const DIGITAL_TEAM_ROLES = [Roles.DIGITAL_MARKETING_HEAD, Roles.DIGITAL_MARKETING_EXECUTIVE];

const appError = (status: number, message: string) => ({ status, message });

// Lite fields that have a real column; everything else optional lives in `extra`.
const COLUMN_FIELDS = [
  'title',
  'location',
  'city',
  'brand_type',
  'category',
  'area_sqft',
  'project_type',
  'developer_name',
  'owner_contact_name',
  'owner_contact_phone',
] as const;

/** Splits a validated lite payload into the typed columns and the `extra` JSON. */
function splitFields(input: Record<string, any>) {
  const columns: Record<string, any> = {};
  const extra: Record<string, any> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === 'type' || key === 'details' || value === undefined) continue;
    if ((COLUMN_FIELDS as readonly string[]).includes(key)) columns[key] = value;
    else if (value !== null) extra[key] = value;
  }
  return { columns, extra };
}

// Commercial is Radha Real Homes, everything else Sonthillu: the same rule as
// the property form (propertyWizardShared.brandForCategory).
const brandFor = (category: string) =>
  category === 'COMMERCIAL_SHOP' || category === 'COMMERCIAL_OFFICE'
    ? 'RADHA_REAL_HOMES'
    : 'SONTHILLU';

/** The per-type details, checked and cleaned; a 400 listing every problem. */
function cleanDetails(type: 'PROPERTY' | 'PROJECT', kindValue: string, raw: unknown) {
  const { problems, values } = checkListingDetails(
    type,
    kindValue,
    (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>,
  );
  if (problems.length) throw appError(400, problems.join(', '));
  return values;
}

// What a client may see of an attachment: never storage_path.
const attachmentSelect = {
  id: true,
  kind: true,
  original_name: true,
  mime: true,
  size: true,
  created_at: true,
} satisfies Prisma.DraftAttachmentSelect;

const draftInclude = {
  submitter: { select: { id: true, full_name: true } },
  picker: { select: { id: true, full_name: true } },
  attachments: { select: attachmentSelect, orderBy: { id: 'asc' as const } },
} satisfies Prisma.DraftSubmissionInclude;

type DraftWithRelations = Prisma.DraftSubmissionGetPayload<{ include: typeof draftInclude }>;

const isMdOrAdmin = (user: TokenPayload) =>
  user.roles.includes(Roles.MD) || user.roles.includes(Roles.ADMIN);

async function isReviewer(user: TokenPayload) {
  return hasEffectivePermission(user, Permissions.DRAFTS_REVIEW);
}

/** The draft, if this person may see it. Submitters see only their own. */
async function loadVisible(user: TokenPayload, id: number): Promise<DraftWithRelations> {
  const companyIds = await getAccessibleCompanyIds(user);
  const draft = await p.draftSubmission.findFirst({
    where: { id, company_id: { in: companyIds } },
    include: draftInclude,
  });
  if (!draft) throw appError(404, 'Listing not found');
  if (draft.submitted_by !== user.employeeId && !(await isReviewer(user))) {
    // Same answer as a missing draft: do not confirm it exists.
    throw appError(404, 'Listing not found');
  }
  return draft;
}

function assertNotOwnDraft(user: TokenPayload, draft: { submitted_by: number }) {
  if (draft.submitted_by === user.employeeId) {
    throw appError(403, 'You cannot review your own listing.');
  }
}

async function holdersOf(roles: string[], companyId: number) {
  return (
    await p.employee.findMany({
      where: {
        company_id: companyId,
        status: 'ACTIVE',
        roles: { some: { role: { name: { in: roles } } } },
      },
      select: { id: true },
    })
  ).map((e) => e.id);
}

async function notify(
  recipients: (number | null | undefined)[],
  actorId: number,
  payload: { type: string; title: string; message: string },
  draftId: number,
) {
  const ids = [...new Set(recipients)].filter((id): id is number => id != null && id !== actorId);
  if (!ids.length) return;
  try {
    await notifyEmployee(ids, { ...payload, link: `/new-listings?open=${draftId}` });
  } catch (err) {
    logger.error(`[Drafts] notification ${payload.type} failed for draft ${draftId}:`, err);
  }
}

const label = (d: { type: string; title: string; id: number }) =>
  `${d.type === 'PROJECT' ? 'project' : 'property'} listing #${d.id} "${d.title}"`;

export class DraftService {
  // ── submit / read ─────────────────────────────────────────────

  static async create(user: TokenPayload, input: DraftCreateInput) {
    const { columns, extra } = splitFields(input);
    const kindValue = input.type === 'PROPERTY' ? input.category : input.project_type;
    const details = cleanDetails(input.type, kindValue, (input as any).details);
    if (Object.keys(details).length) extra.details = details;
    if (input.type === 'PROPERTY') {
      columns.brand_type = columns.brand_type || brandFor(input.category);
      columns.area_sqft = listingAreaSqft(input.category, details);
    }
    const draft = await p.draftSubmission.create({
      data: {
        company_id: user.companyId,
        type: input.type,
        submitted_by: user.employeeId,
        ...columns,
        extra: Object.keys(extra).length ? (extra as Prisma.InputJsonValue) : undefined,
      } as Prisma.DraftSubmissionUncheckedCreateInput,
      include: draftInclude,
    });

    let recipients = await holdersOf(DIGITAL_TEAM_ROLES, user.companyId);
    if (!recipients.length) recipients = await holdersOf([Roles.MD], user.companyId);
    await notify(
      recipients,
      user.employeeId,
      {
        type: 'DRAFT_SUBMITTED',
        title: `New ${draft.type === 'PROJECT' ? 'project' : 'property'} listing`,
        message: `A new ${label(draft)} was sent in and is waiting for the digital team.`,
      },
      draft.id,
    );
    return draft;
  }

  static async list(
    user: TokenPayload,
    q: { status?: string; type?: string; limit: number; offset: number },
  ) {
    const companyIds = await getAccessibleCompanyIds(user);
    const reviewer = await isReviewer(user);
    const where: Prisma.DraftSubmissionWhereInput = {
      company_id: { in: companyIds },
      ...(reviewer ? {} : { submitted_by: user.employeeId }),
      // One status, or several separated by commas.
      ...(q.status ? { status: { in: q.status.split(',') as any } } : {}),
      ...(q.type ? { type: q.type as any } : {}),
    };
    const [drafts, total] = await Promise.all([
      p.draftSubmission.findMany({
        where,
        include: draftInclude,
        orderBy: { created_at: 'desc' },
        take: q.limit,
        skip: q.offset,
      }),
      p.draftSubmission.count({ where }),
    ]);
    return { drafts, total };
  }

  static async get(user: TokenPayload, id: number) {
    return loadVisible(user, id);
  }

  // ── submitter ────────────────────────────────────────────────

  /** Submitter edits while nobody has finished with it (SUBMITTED or NEEDS_INFO). */
  static async update(user: TokenPayload, id: number, body: Record<string, any>) {
    const draft = await loadVisible(user, id);
    if (draft.submitted_by !== user.employeeId) throw appError(403, 'Only the submitter can edit.');
    if (draft.status !== 'SUBMITTED' && draft.status !== 'NEEDS_INFO') {
      throw appError(409, 'This listing is being worked on and can no longer be edited.');
    }
    const schema = draft.type === 'PROJECT' ? ProjectDraftUpdateSchema : PropertyDraftUpdateSchema;
    const parsed = schema.parse(body) as Record<string, any>;
    const { columns, extra } = splitFields(parsed);
    const mergedExtra: Record<string, any> = {
      ...((draft.extra as Record<string, any> | null) ?? {}),
      ...extra,
    };
    for (const [k, v] of Object.entries(parsed)) if (v === null) delete mergedExtra[k];
    // The details are checked as a whole against the (possibly new) type.
    const kindValue =
      draft.type === 'PROPERTY'
        ? (parsed.category ?? draft.category ?? '')
        : (parsed.project_type ?? draft.project_type ?? '');
    const details = cleanDetails(
      draft.type,
      kindValue,
      'details' in parsed ? parsed.details : mergedExtra.details,
    );
    if (Object.keys(details).length) mergedExtra.details = details;
    else delete mergedExtra.details;
    if (draft.type === 'PROPERTY') {
      if (parsed.category && !parsed.brand_type) columns.brand_type = brandFor(parsed.category);
      columns.area_sqft = listingAreaSqft(kindValue, details);
    }
    return p.draftSubmission.update({
      where: { id },
      data: {
        ...columns,
        extra: Object.keys(mergedExtra).length
          ? (mergedExtra as Prisma.InputJsonValue)
          : Prisma.DbNull,
      },
      include: draftInclude,
    });
  }

  /** Submitter answers a NEEDS_INFO request; it goes back to the person who asked. */
  static async reply(user: TokenPayload, id: number, note?: string) {
    const draft = await loadVisible(user, id);
    if (draft.submitted_by !== user.employeeId)
      throw appError(403, 'Only the submitter can reply.');
    const moved = await p.draftSubmission.updateMany({
      where: { id, status: 'NEEDS_INFO' },
      data: { status: 'IN_PROGRESS', status_note: note?.trim() || null },
    });
    if (!moved.count) throw appError(409, 'This listing is not waiting for information.');
    await notify(
      [draft.picked_by],
      user.employeeId,
      {
        type: 'DRAFT_INFO_PROVIDED',
        title: 'Listing updated',
        message: `The submitter answered your question on ${label(draft)}.`,
      },
      id,
    );
    return loadVisible(user, id);
  }

  // ── reviewer ─────────────────────────────────────────────────

  /** Pick up a SUBMITTED draft. Atomic: two reviewers cannot both take it. */
  static async accept(user: TokenPayload, id: number) {
    const draft = await loadVisible(user, id);
    assertNotOwnDraft(user, draft);
    const moved = await p.draftSubmission.updateMany({
      where: { id, status: 'SUBMITTED' },
      data: { status: 'IN_PROGRESS', picked_by: user.employeeId, picked_at: new Date() },
    });
    if (!moved.count) throw appError(409, 'Someone else already picked up this listing.');
    await notify(
      [draft.submitted_by],
      user.employeeId,
      {
        type: 'DRAFT_ACCEPTED',
        title: 'Your listing is being worked on',
        message: `The digital team picked up your ${label(draft)}.`,
      },
      id,
    );
    return loadVisible(user, id);
  }

  private static assertWorkingOn(user: TokenPayload, draft: { picked_by: number | null }) {
    if (draft.picked_by !== user.employeeId && !isMdOrAdmin(user)) {
      throw appError(403, 'Only the person working on this listing can do that.');
    }
  }

  static async needsInfo(user: TokenPayload, id: number, note: string) {
    const draft = await loadVisible(user, id);
    assertNotOwnDraft(user, draft);
    this.assertWorkingOn(user, draft);
    const moved = await p.draftSubmission.updateMany({
      where: { id, status: 'IN_PROGRESS' },
      data: { status: 'NEEDS_INFO', status_note: note },
    });
    if (!moved.count) throw appError(409, 'This listing is not in progress.');
    await notify(
      [draft.submitted_by],
      user.employeeId,
      {
        type: 'DRAFT_NEEDS_INFO',
        title: 'More information needed',
        message: `Your ${label(draft)} needs more information: ${note}`,
      },
      id,
    );
    return loadVisible(user, id);
  }

  /**
   * Link the real record the reviewer created through the normal endpoints.
   * To keep "Ready in CRM" (and the target credit it carries) honest the record
   * must be in the draft's company, of the draft's type, created by the person
   * linking it (MD/Admin excepted) AFTER they picked the draft up, and not
   * already linked to another draft.
   */
  static async link(user: TokenPayload, id: number, recordId: number) {
    const draft = await loadVisible(user, id);
    assertNotOwnDraft(user, draft);
    this.assertWorkingOn(user, draft);
    if (draft.status !== 'IN_PROGRESS') throw appError(409, 'This listing is not in progress.');

    const isProject = draft.type === 'PROJECT';
    const record = isProject
      ? await p.project.findFirst({
          where: { id: recordId, company_id: draft.company_id },
          select: { id: true, created_by_id: true, created_at: true },
        })
      : await p.property.findFirst({
          where: { id: recordId, company_id: draft.company_id },
          select: { id: true, created_by_id: true, created_at: true },
        });
    if (!record) {
      throw appError(404, `${isProject ? 'Project' : 'Property'} not found in this company.`);
    }
    if (!isMdOrAdmin(user)) {
      if (record.created_by_id !== user.employeeId) {
        throw appError(403, 'You can only link a record that you created.');
      }
      if (draft.picked_at && record.created_at < draft.picked_at) {
        throw appError(409, 'That record was created before you picked up this listing.');
      }
    }
    const taken = await p.draftSubmission.findFirst({
      where: isProject ? { linked_project_id: recordId } : { linked_property_id: recordId },
      select: { id: true },
    });
    if (taken) throw appError(409, `That record is already linked to listing #${taken.id}.`);

    try {
      const moved = await p.draftSubmission.updateMany({
        where: { id, status: 'IN_PROGRESS' },
        data: {
          status: 'READY_IN_CRM',
          ready_at: new Date(),
          status_note: null,
          ...(isProject ? { linked_project_id: recordId } : { linked_property_id: recordId }),
        },
      });
      if (!moved.count) throw appError(409, 'This listing is not in progress.');
    } catch (err: any) {
      if (err?.code === 'P2002') throw appError(409, 'That record is already linked to a listing.');
      throw err;
    }
    await notify(
      [draft.submitted_by],
      user.employeeId,
      {
        type: 'DRAFT_READY',
        title: 'Your listing is ready in the CRM',
        message: `Your ${label(draft)} is now in the CRM.`,
      },
      id,
    );
    return loadVisible(user, id);
  }

  /**
   * The digital team found that this is already in the CRM (2026-11-27), so it is not added twice. If they
   * name a record they themselves created after moving the listing to Pending, it counts as their work, as
   * before. Anything else is closed without target credit for anyone.
   */
  static async alreadyInCrm(user: TokenPayload, id: number, recordId?: number | null) {
    const draft = await loadVisible(user, id);
    assertNotOwnDraft(user, draft);
    if (draft.status === 'READY_IN_CRM')
      throw appError(409, 'This listing is already marked as in the CRM.');

    const isProject = draft.type === 'PROJECT';
    let record: {
      id: number;
      name: string;
      created_by_id: number | null;
      created_at: Date;
    } | null = null;
    if (recordId) {
      const where = { id: recordId, company_id: draft.company_id };
      if (isProject) {
        record = await p.project.findFirst({
          where,
          select: { id: true, name: true, created_by_id: true, created_at: true },
        });
      } else {
        const found = await p.property.findFirst({
          where,
          select: { id: true, title: true, created_by_id: true, created_at: true },
        });
        record = found ? { ...found, name: found.title } : null;
      }
      if (!record)
        throw appError(404, `${isProject ? 'Project' : 'Property'} not found in this company.`);

      const theirWork =
        draft.status === 'IN_PROGRESS' &&
        draft.picked_by === user.employeeId &&
        record.created_by_id === user.employeeId &&
        !!draft.picked_at &&
        record.created_at >= draft.picked_at;
      const taken = await p.draftSubmission.findFirst({
        where: isProject ? { linked_project_id: record.id } : { linked_property_id: record.id },
        select: { id: true },
      });
      if (theirWork && !taken) return this.link(user, id, record.id);
    }

    const me = await p.employee.findUnique({
      where: { id: user.employeeId },
      select: { full_name: true, employee_code: true },
    });
    const mark = {
      record_id: record?.id ?? null,
      record_name: record?.name ?? null,
      by: user.employeeId,
      by_name: me?.full_name || me?.employee_code || null,
      at: new Date().toISOString(),
    };
    const moved = await p.draftSubmission.updateMany({
      where: { id, status: { in: ['SUBMITTED', 'IN_PROGRESS', 'NEEDS_INFO'] } },
      data: {
        status: 'READY_IN_CRM',
        ready_at: null,
        status_note: null,
        extra: {
          ...((draft.extra as Record<string, unknown> | null) ?? {}),
          already_in_crm: mark,
        } as Prisma.InputJsonValue,
      },
    });
    if (!moved.count) throw appError(409, 'This listing was just changed. Reload and try again.');
    await notify(
      [draft.submitted_by],
      user.employeeId,
      {
        type: 'DRAFT_READY',
        title: 'Your listing is already in the CRM',
        message: `Your ${label(draft)} is already in the CRM${record ? ` as "${record.name}"` : ''}.`,
      },
      id,
    );
    return loadVisible(user, id);
  }

  /** Marked "already in CRM" by mistake: back to Pending, with the person who undid it. */
  static async notInCrm(user: TokenPayload, id: number) {
    const draft = await loadVisible(user, id);
    assertNotOwnDraft(user, draft);
    const extra = { ...((draft.extra as Record<string, unknown> | null) ?? {}) };
    if (draft.status !== 'READY_IN_CRM' || !extra.already_in_crm)
      throw appError(409, 'Only a listing marked "already in CRM" can be moved back.');
    delete extra.already_in_crm;
    const moved = await p.draftSubmission.updateMany({
      where: { id, status: 'READY_IN_CRM' },
      data: {
        status: 'IN_PROGRESS',
        picked_by: user.employeeId,
        picked_at: new Date(),
        extra: Object.keys(extra).length ? (extra as Prisma.InputJsonValue) : Prisma.DbNull,
      },
    });
    if (!moved.count) throw appError(409, 'This listing was just changed. Reload and try again.');
    return loadVisible(user, id);
  }

  // ── filling the empty details of an existing record ──────────

  /** The record and what the listing could fill in it. Reviewers only (the route checks the permission). */
  private static async fillPlan(
    db: Prisma.TransactionClient,
    draft: DraftWithRelations,
    recordId: number,
  ) {
    const isProject = draft.type === 'PROJECT';
    const where = { id: recordId, company_id: draft.company_id };
    const record: any = isProject
      ? await db.project.findFirst({ where })
      : await db.property.findFirst({ where });
    if (!record)
      throw appError(404, `${isProject ? 'Project' : 'Property'} not found in this company.`);
    const plan = isProject ? projectFill(draft, record) : propertyFill(draft, record);
    return { isProject, name: (isProject ? record.name : record.title) as string, ...plan };
  }

  static async fillPreview(user: TokenPayload, id: number, recordId: number) {
    const draft = await loadVisible(user, id);
    assertNotOwnDraft(user, draft);
    const { name, items } = await this.fillPlan(p, draft, recordId);
    return { name, items };
  }

  /** Saves the empty details only, and writes in the record's history what came from the listing. */
  static async fill(user: TokenPayload, id: number, recordId: number) {
    const draft = await loadVisible(user, id);
    assertNotOwnDraft(user, draft);
    const done = await p.$transaction(async (tx) => {
      // Worked out again here, from the record as it is now, not from what the screen showed.
      const plan = await this.fillPlan(tx, draft, recordId);
      if (!plan.items.length) return plan;
      if (plan.isProject)
        await tx.project.update({ where: { id: recordId }, data: plan.data as any });
      else await tx.property.update({ where: { id: recordId }, data: plan.data as any });
      await tx.auditEvent.create({
        data: {
          actor_id: user.employeeId,
          action: 'LISTING_DETAILS_FILLED',
          entity_type: plan.isProject ? 'PROJECT' : 'PROPERTY',
          entity_id: recordId,
          company_id: draft.company_id,
          reason: `Empty details filled from listing #${draft.id}: ${plan.items.map((i) => i.label).join(', ')}`,
        },
      });
      return plan;
    });
    if (done.isProject && done.items.length) invalidateProjectListCache();
    return { name: done.name, items: done.items };
  }

  // ── attachments ──────────────────────────────────────────────

  static async addAttachment(
    user: TokenPayload,
    id: number,
    file: { path: string; originalname: string; size: number },
    askedKind?: string,
  ) {
    const draft = await loadVisible(user, id);
    if (draft.submitted_by !== user.employeeId) {
      throw appError(403, 'Only the person who sent the listing can add files.');
    }
    // Adding is still allowed while the digital team is on it (a photo may be
    // missing or have failed); changing or removing what is there is not.
    if (draft.status === 'READY_IN_CRM') {
      throw appError(409, 'This listing is already in the CRM and can no longer be changed.');
    }
    if (draft.attachments.length >= DRAFT_ATTACHMENT_MAX_PER_DRAFT) {
      throw appError(409, `A listing can have at most ${DRAFT_ATTACHMENT_MAX_PER_DRAFT} files.`);
    }
    const prepared = await prepareDraftFile(file.path, file.originalname, file.size, askedKind);
    if (
      prepared.kind === 'VIDEO' &&
      draft.attachments.filter((a) => a.kind === 'VIDEO').length >= DRAFT_VIDEO_MAX_PER_DRAFT
    ) {
      throw appError(409, `A listing can have at most ${DRAFT_VIDEO_MAX_PER_DRAFT} videos.`);
    }
    const storage = getDraftStorage();
    const storagePath = await storage.put(prepared.source, prepared.storedName);
    try {
      return await p.draftAttachment.create({
        data: {
          draft_id: id,
          kind: prepared.kind,
          storage_path: storagePath,
          original_name: prepared.storedName,
          mime: prepared.mime,
          size: prepared.size,
          uploaded_by: user.employeeId,
        },
        select: attachmentSelect,
      });
    } catch (err) {
      await storage.delete(storagePath).catch(() => undefined);
      throw err;
    }
  }

  /** Where a file is, only for someone who may see this listing. */
  static async attachmentFor(user: TokenPayload, id: number, attachmentId: number) {
    await loadVisible(user, id);
    return this.attachmentById(id, attachmentId);
  }

  /** For a request carrying a valid media link (checked by the route). */
  static async attachmentById(id: number, attachmentId: number) {
    const att = await p.draftAttachment.findFirst({ where: { id: attachmentId, draft_id: id } });
    if (!att) throw appError(404, 'File not found');
    return att;
  }

  /** Every file of a listing, for the "download all" zip. */
  static async allAttachments(id: number) {
    const draft = await p.draftSubmission.findUnique({
      where: { id },
      select: {
        id: true,
        title: true,
        attachments: {
          orderBy: { id: 'asc' },
          select: { original_name: true, storage_path: true },
        },
      },
    });
    if (!draft) throw appError(404, 'Listing not found');
    return draft;
  }

  /** A 30-minute link key so the page can show photos and play videos. */
  static async mediaToken(user: TokenPayload, id: number) {
    await loadVisible(user, id);
    return signMediaToken(user.employeeId, id);
  }

  static async removeAttachment(user: TokenPayload, id: number, attachmentId: number) {
    const draft = await loadVisible(user, id);
    if (draft.submitted_by !== user.employeeId) {
      throw appError(403, 'Only the person who sent the listing can remove files.');
    }
    if (draft.status !== 'SUBMITTED' && draft.status !== 'NEEDS_INFO') {
      throw appError(409, 'This listing is being worked on and can no longer be changed.');
    }
    const att = await p.draftAttachment.findFirst({ where: { id: attachmentId, draft_id: id } });
    if (!att) throw appError(404, 'File not found');
    await p.draftAttachment.delete({ where: { id: attachmentId } });
    await getDraftStorage()
      .delete(att.storage_path)
      .catch((err) =>
        logger.error(`[Listings] could not delete file of attachment ${att.id}`, err),
      );
  }
}
