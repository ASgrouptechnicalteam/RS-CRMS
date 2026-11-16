import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { TokenPayload } from '../utils/jwt';
import { buildProjectScope } from '../authz/dataScope';
import { Roles, Permissions } from '../shared';

const p = prisma;

/** A pending review step waiting longer than this is flagged overdue. */
export const ATTENTION_OVERDUE_DAYS = 3;

export type ProjectAttentionKind =
  'SUBMIT' | 'FIX_REJECTED' | 'MARKETING_REVIEW' | 'DM_POLISH' | 'MD_APPROVAL';

export interface ProjectAttentionItem {
  id: number;
  name: string;
  project_code: string;
  kind: ProjectAttentionKind;
  /** What this person has to do, in plain words. */
  action: string;
  /** Rejection reason / reviewer notes, when there are any. */
  note: string | null;
  waiting_since: Date;
  days_waiting: number;
  overdue: boolean;
  /** For drafts / rejected: what is still missing before it is worth submitting. */
  missing: string[];
}

/**
 * What a project still lacks before it is worth sending for review. Advisory
 * (never blocks a submit) — it saves the round trip of an incomplete project
 * being sent up and rejected.
 */
export async function projectMissing(projectIds: number[]): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  if (!projectIds.length) return out;
  const [rows, units] = await Promise.all([
    p.project.findMany({
      where: { id: { in: projectIds } },
      select: {
        id: true,
        cover_image_url: true,
        description: true,
        city: true,
        rera_number: true,
        rera_status: true,
        assigned_pm_id: true,
      },
    }),
    p.projectUnit.groupBy({
      by: ['project_id'],
      where: { project_id: { in: projectIds } },
      _count: { _all: true },
    }),
  ]);
  const withUnits = new Set(units.map((u) => u.project_id));
  for (const r of rows) {
    const m: string[] = [];
    if (!r.cover_image_url) m.push('Cover photo');
    if (!r.description?.trim()) m.push('Description');
    if (!r.city?.trim()) m.push('City');
    if (r.rera_status !== 'NOT_APPLICABLE' && !r.rera_number?.trim()) m.push('RERA number');
    if (!r.assigned_pm_id) m.push('Project Manager');
    if (!withUnits.has(r.id)) m.push('At least one unit');
    out.set(r.id, m);
  }
  return out;
}

const ACTION: Record<ProjectAttentionKind, string> = {
  SUBMIT: 'Finish the details and submit for review',
  FIX_REJECTED: 'Rejected — fix it and submit again',
  MARKETING_REVIEW: 'Marketing review needed',
  DM_POLISH: 'Add photos, SEO and description, then submit to MD',
  MD_APPROVAL: 'Waiting for your approval',
};

/**
 * Projects that need THIS person to do something now, by the review chain:
 *  - the PM / person who added it: a draft not yet submitted, or one the MD rejected
 *  - the DM Head: projects waiting for Marketing review
 *  - the MD (and anyone with the verify permission): projects waiting for approval
 * Always inside the person's own project scope, so it never lists anything they
 * could not open.
 */
export async function getProjectAttention(user: TokenPayload): Promise<{
  total: number;
  overdue: number;
  by_kind: Record<ProjectAttentionKind, number>;
  items: ProjectAttentionItem[];
}> {
  const me = user.employeeId;
  const perms = user.permissions || [];
  const roles = user.roles || [];
  const or: Prisma.ProjectWhereInput[] = [];

  if (perms.includes(Permissions.PROJECTS_SUBMIT_VERIFY)) {
    or.push({
      verification_status: { in: ['DRAFT', 'REJECTED'] },
      OR: [{ assigned_pm_id: me }, { created_by_id: me }],
    });
  }
  if (
    roles.includes(Roles.DIGITAL_MARKETING_HEAD) &&
    perms.includes(Permissions.PROJECTS_DM_POLISH)
  ) {
    or.push({ verification_status: 'PENDING_DM_POLISH' });
  }
  if (
    roles.includes(Roles.DIGITAL_MARKETING_EXECUTIVE) &&
    perms.includes(Permissions.PROJECTS_DM_POLISH)
  ) {
    or.push({ verification_status: 'PENDING_DM_EXEC', digital_marketing_executive_id: me });
  }
  if (perms.includes(Permissions.PROJECTS_VERIFY)) {
    or.push({ verification_status: { in: ['PENDING_MD_APPROVAL', 'PENDING_VERIFICATION'] } });
  }

  const by_kind: Record<ProjectAttentionKind, number> = {
    SUBMIT: 0,
    FIX_REJECTED: 0,
    MARKETING_REVIEW: 0,
    DM_POLISH: 0,
    MD_APPROVAL: 0,
  };
  if (!or.length) return { total: 0, overdue: 0, by_kind, items: [] };

  const scope = await buildProjectScope(user);
  const rows = await p.project.findMany({
    where: { AND: [scope, { status: { not: 'CANCELLED' } }, { OR: or }] },
    select: {
      id: true,
      name: true,
      project_code: true,
      verification_status: true,
      verification_notes: true,
      updated_at: true,
    },
    orderBy: { updated_at: 'asc' },
    take: 200,
  });

  const now = Date.now();
  const missing = await projectMissing(
    rows
      .filter((r) => r.verification_status === 'DRAFT' || r.verification_status === 'REJECTED')
      .map((r) => r.id),
  );
  const items = rows.map((r): ProjectAttentionItem => {
    const kind: ProjectAttentionKind =
      r.verification_status === 'DRAFT'
        ? 'SUBMIT'
        : r.verification_status === 'REJECTED'
          ? 'FIX_REJECTED'
          : r.verification_status === 'PENDING_DM_POLISH'
            ? 'MARKETING_REVIEW'
            : r.verification_status === 'PENDING_DM_EXEC'
              ? 'DM_POLISH'
              : 'MD_APPROVAL';
    const days = Math.floor((now - r.updated_at.getTime()) / 86_400_000);
    by_kind[kind]++;
    return {
      id: r.id,
      name: r.name,
      project_code: r.project_code,
      kind,
      action: ACTION[kind],
      note: kind === 'FIX_REJECTED' ? r.verification_notes : null,
      waiting_since: r.updated_at,
      days_waiting: days,
      // A draft is the owner's own pace; only queued reviews count as overdue.
      overdue: kind !== 'SUBMIT' && kind !== 'FIX_REJECTED' && days >= ATTENTION_OVERDUE_DAYS,
      missing: missing.get(r.id) || [],
    };
  });

  return {
    total: items.length,
    overdue: items.filter((i) => i.overdue).length,
    by_kind,
    items,
  };
}
