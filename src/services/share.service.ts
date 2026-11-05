// Sharing project, unit and property details with a customer: the staff side,
// and the no-login page the customer opens from WhatsApp. Everything a customer
// can see is built here from named fields, so internal data cannot leak by default.
import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { TokenPayload } from '../utils/jwt';
import { buildLeadScope, buildProjectScope, buildPropertyScope } from '../authz/dataScope';
import { Roles } from '../shared';
import { logger } from '../utils/logger';
import { notifyEmployee } from '../utils/notifyEmployee';
import { publicAssetUrl } from '../utils/media';
import { normalizeIndianPhone } from '../utils/phone';
import { AppError } from './lead/errors';
import { MessageTemplateService } from './messageTemplate.service';

const p = prisma as any;

const LINK_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const NOTIFY_AGAIN_MS = 24 * 60 * 60 * 1000;
const APP_URL = () => (process.env.APP_URL || 'http://localhost:5173').replace(/\/$/, '');

export type ShareKind = 'PROJECT' | 'UNIT' | 'PROPERTY';
export const SECTION_KEYS = [
  'overview',
  'price',
  'location',
  'brochure',
  'plans',
  'photos',
] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];
export type Sections = Record<SectionKey, boolean>;

const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

export const formatPrice = (value?: number | null): string | null => {
  if (!value || value <= 0) return null;
  if (value >= 10000000) return `₹${(value / 10000000).toFixed(2).replace(/\.?0+$/, '')} Cr`;
  return `₹${(value / 100000).toFixed(2).replace(/\.?0+$/, '')} Lakhs`;
};

const parseList = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
};

/** Whether a project may go out without a RERA number. */
function reraCheck(project: {
  rera_number?: string | null;
  rera_status?: string | null;
  approval_authorities?: unknown;
}): { blocked?: string; warning?: string } {
  if (project.rera_number?.trim() || project.rera_status === 'NOT_APPLICABLE') return {};
  const required =
    project.rera_status === 'APPROVED' ||
    project.rera_status === 'APPLIED' ||
    parseList(project.approval_authorities).includes('RERA');
  return required
    ? { blocked: 'This project needs a RERA number before it can be shared. Ask its PM to add it.' }
    : { warning: 'No RERA number is recorded for this project.' };
}

const PROJECT_FIELDS = {
  id: true,
  company_id: true,
  name: true,
  description: true,
  location: true,
  address: true,
  city: true,
  state: true,
  pincode: true,
  rera_number: true,
  rera_status: true,
  approval_authorities: true,
  status: true,
  is_published: true,
  verification_status: true,
  cover_image_url: true,
};

const UNIT_FIELDS = {
  id: true,
  company_id: true,
  project_id: true,
  unit_code: true,
  unit_number: true,
  unit_type: true,
  bhk: true,
  bedrooms: true,
  bathrooms: true,
  facing: true,
  plot_area_sqyd: true,
  super_built_up_area_sqft: true,
  built_up_area_sqft: true,
  carpet_area_sqft: true,
  area_sqft: true,
  final_price: true,
  sales_status: true,
  is_published: true,
  images: {
    select: { image_url: true },
    orderBy: [{ sort_order: 'asc' }, { created_at: 'asc' }],
  },
};

const PROPERTY_FIELDS = {
  id: true,
  company_id: true,
  project_id: true,
  title: true,
  description: true,
  category: true,
  final_price: true,
  area_sqft: true,
  location: true,
  address: true,
  city: true,
  state: true,
  pincode: true,
  bedrooms: true,
  bathrooms: true,
  facing: true,
  amenities: true,
  possession_status: true,
  status: true,
  locked_until: true,
  images: {
    where: { status: { in: ['APPROVED', 'PENDING'] } },
    select: { image_url: true },
    orderBy: [{ sort_order: 'asc' }, { created_at: 'asc' }],
  },
};

export interface ShareContent {
  kind: ShareKind;
  id: number;
  company_id: number;
  title: string;
  subtitle: string | null;
  description: string | null;
  facts: { label: string; value: string }[];
  amenities: string[];
  price_label: string | null;
  location: string | null;
  address: string | null;
  rera_number: string | null;
  cover: string | null;
  photos: string[];
  videos: string[];
  brochures: { title: string; url: string }[];
  plans: { title: string; url: string }[];
  blocked: string | null;
  warnings: string[];
}

const joinAddress = (row: any) =>
  [row.address, row.city, row.state, row.pincode].filter(Boolean).join(', ') || null;
const humanise = (value?: string | null) =>
  value
    ? value
        .replace(/_/g, ' ')
        .toLowerCase()
        .replace(/^\w/, (c) => c.toUpperCase())
    : null;

async function projectMedia(projectId: number) {
  const rows: { kind: string; url: string; title: string | null }[] = await p.projectMedia.findMany(
    {
      where: { project_id: projectId },
      orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
      select: { kind: true, url: true, title: true },
    },
  );
  const url = (u: string) => publicAssetUrl(u) as string;
  const named = (kinds: string[], fallback: string) =>
    rows
      .filter((r) => kinds.includes(r.kind))
      .map((r) => ({ title: r.title || fallback, url: url(r.url) }));
  return {
    photos: rows.filter((r) => r.kind === 'GALLERY').map((r) => url(r.url)),
    videos: rows.filter((r) => r.kind === 'VIDEO').map((r) => url(r.url)),
    brochures: named(['BROCHURE'], 'Brochure'),
    plans: [
      ...named(['MASTER_PLAN'], 'Master plan'),
      ...named(['LAYOUT_PLAN'], 'Layout plan'),
      ...named(['FLOOR_PLAN'], 'Floor plan'),
    ],
  };
}

const projectBlock = (project: any): string | null => {
  if (project.status === 'CANCELLED') return 'This project has been cancelled.';
  if (project.verification_status !== 'VERIFIED' || !project.is_published) {
    return 'Only projects approved by the MD and published can be shared.';
  }
  return null;
};

async function projectAmenityNames(projectId: number): Promise<string[]> {
  const rows = await p.projectAmenity.findMany({
    where: { project_id: projectId },
    orderBy: { sort_order: 'asc' },
    select: { amenity: { select: { name: true } } },
  });
  return rows.map((r: any) => r.amenity?.name).filter(Boolean);
}

async function loadProjectBase(project: any) {
  const media = await projectMedia(project.id);
  const coverRow = await p.projectMedia.findFirst({
    where: { project_id: project.id, kind: 'COVER' },
    orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
    select: { url: true },
  });
  const rera = reraCheck(project);
  return {
    media,
    rera,
    blocked: projectBlock(project) || rera.blocked || null,
    warnings: rera.warning ? [rera.warning] : [],
    amenities: await projectAmenityNames(project.id),
    cover: publicAssetUrl(project.cover_image_url || coverRow?.url),
  };
}

/** Loads what a customer may see. Returns null when the record does not exist. */
export async function loadContent(
  kind: ShareKind,
  id: number,
  where: Record<string, unknown> = {},
): Promise<ShareContent | null> {
  if (kind === 'PROJECT') {
    const project = await p.project.findFirst({
      where: { id, ...where },
      select: PROJECT_FIELDS,
    });
    if (!project) return null;
    const base = await loadProjectBase(project);
    const units = await p.projectUnit.findMany({
      where: { project_id: id, is_published: true, sales_status: 'AVAILABLE' },
      select: { final_price: true },
    });
    const prices = units.map((u: any) => u.final_price).filter((v: any) => v > 0);
    const from = prices.length ? Math.min(...prices) : null;
    return {
      kind,
      id,
      company_id: project.company_id,
      title: project.name,
      subtitle: humanise(project.status),
      description: project.description,
      facts: units.length ? [{ label: 'Available units', value: String(units.length) }] : [],
      amenities: base.amenities,
      price_label: formatPrice(from),
      location: project.location,
      address: joinAddress(project),
      rera_number: project.rera_number?.trim() || null,
      ...base.media,
      cover: base.cover,
      blocked: base.blocked,
      warnings: base.warnings,
    };
  }

  if (kind === 'UNIT') {
    const unit = await p.projectUnit.findFirst({ where: { id }, select: UNIT_FIELDS });
    if (!unit) return null;
    const project = await p.project.findFirst({
      where: { id: unit.project_id, ...where },
      select: PROJECT_FIELDS,
    });
    if (!project) return null;
    const base = await loadProjectBase(project);
    const area = unit.plot_area_sqyd
      ? `${unit.plot_area_sqyd} Sq.Yd`
      : unit.super_built_up_area_sqft || unit.built_up_area_sqft || unit.area_sqft
        ? `${unit.super_built_up_area_sqft || unit.built_up_area_sqft || unit.area_sqft} Sq.Ft`
        : null;
    const facts = [
      { label: 'Type', value: [unit.bhk, humanise(unit.unit_type)].filter(Boolean).join(' ') },
      { label: 'Area', value: area },
      { label: 'Facing', value: humanise(unit.facing) },
      { label: 'Bedrooms', value: unit.bedrooms ? String(unit.bedrooms) : null },
      { label: 'Bathrooms', value: unit.bathrooms ? String(unit.bathrooms) : null },
    ].filter((f) => f.value) as { label: string; value: string }[];
    const unitPhotos = unit.images.map((i: any) => publicAssetUrl(i.image_url) as string);
    return {
      kind,
      id,
      company_id: project.company_id,
      title: `${project.name}, Unit ${unit.unit_number}`,
      subtitle: humanise(project.status),
      description: project.description,
      facts,
      amenities: base.amenities,
      price_label: formatPrice(unit.final_price),
      location: project.location,
      address: joinAddress(project),
      rera_number: project.rera_number?.trim() || null,
      ...base.media,
      cover: unitPhotos[0] || base.cover,
      photos: [...unitPhotos, ...base.media.photos],
      blocked:
        base.blocked ||
        (!unit.is_published || unit.sales_status !== 'AVAILABLE'
          ? 'This unit is not available for sale right now.'
          : null),
      warnings: base.warnings,
    };
  }

  const property = await p.property.findFirst({ where: { id, ...where }, select: PROPERTY_FIELDS });
  if (!property) return null;
  const published = await p.propertyPublication.findFirst({
    where: { property_id: id, is_published: true },
    select: { id: true },
  });
  const live =
    property.status === 'LIVE' ||
    (property.status === 'LOCKED' && property.locked_until && property.locked_until < new Date());
  const parent = property.project_id
    ? await p.project.findFirst({ where: { id: property.project_id }, select: PROJECT_FIELDS })
    : null;
  const rera = parent ? reraCheck(parent) : {};
  const photos = property.images.map((i: any) => publicAssetUrl(i.image_url) as string);
  const facts = [
    { label: 'Type', value: humanise(property.category) },
    { label: 'Area', value: property.area_sqft ? `${property.area_sqft} Sq.Ft` : null },
    { label: 'Facing', value: humanise(property.facing) },
    { label: 'Bedrooms', value: property.bedrooms ? String(property.bedrooms) : null },
    { label: 'Bathrooms', value: property.bathrooms ? String(property.bathrooms) : null },
    { label: 'Possession', value: humanise(property.possession_status) },
  ].filter((f) => f.value) as { label: string; value: string }[];
  return {
    kind,
    id,
    company_id: property.company_id,
    title: property.title,
    subtitle: parent?.name || null,
    description: property.description,
    facts,
    amenities: parseList(property.amenities),
    price_label: formatPrice(property.final_price),
    location: property.location,
    address: joinAddress(property),
    rera_number: parent?.rera_number?.trim() || null,
    cover: photos[0] || null,
    photos,
    videos: [],
    brochures: [],
    plans: [],
    blocked:
      !published || !live
        ? 'Only properties approved and live on the website can be shared.'
        : rera.blocked || null,
    warnings: rera.warning ? [rera.warning] : [],
  };
}

/** The same record, but only if this person can see it. */
async function loadForUser(user: TokenPayload, kind: ShareKind, id: number) {
  const where =
    kind === 'PROPERTY' ? await buildPropertyScope(user) : await buildProjectScope(user);
  const content = await loadContent(kind, id, where as Record<string, unknown>);
  if (!content) throw new AppError(404, 'Not found, or you do not have access to it');
  return content;
}

const stripInternal = (content: ShareContent, sections: Sections) => ({
  kind: content.kind,
  title: content.title,
  subtitle: content.subtitle,
  description: sections.overview ? content.description : null,
  facts: sections.overview ? content.facts : [],
  amenities: sections.overview ? content.amenities : [],
  price_label: sections.price ? content.price_label : null,
  location: sections.location ? content.location : null,
  address: sections.location ? content.address : null,
  // Always shown when there is one.
  rera_number: content.rera_number,
  cover: sections.photos ? content.cover : null,
  photos: sections.photos ? content.photos : [],
  videos: sections.photos ? content.videos : [],
  brochures: sections.brochure ? content.brochures : [],
  plans: sections.plans ? content.plans : [],
});

const linkSummary = (row: any) => ({
  id: row.id,
  kind: row.kind,
  target_id: row.target_id,
  lead_id: row.lead_id,
  created_at: row.created_at,
  expires_at: row.expires_at,
  revoked_at: row.revoked_at,
  open_count: row.open_count,
  first_opened_at: row.first_opened_at,
  last_opened_at: row.last_opened_at,
  interested_at: row.interested_at,
  active: !row.revoked_at && row.expires_at > new Date(),
});

export async function getShareDetails(user: TokenPayload, kind: ShareKind, id: number) {
  const content = await loadForUser(user, kind, id);
  const links = await p.shareLink.findMany({
    where: { kind, target_id: id, created_by_id: user.employeeId },
    orderBy: { id: 'desc' },
    take: 10,
  });
  return {
    item: {
      kind,
      id,
      title: content.title,
      price_label: content.price_label,
      location: content.location,
      rera_number: content.rera_number,
      counts: {
        photos: content.photos.length + content.videos.length,
        brochures: content.brochures.length,
        plans: content.plans.length,
      },
      has_overview: !!content.description || content.facts.length > 0,
      blocked: content.blocked,
      warnings: content.warnings,
      brochures: content.brochures,
    },
    links: links.map(linkSummary),
  };
}

/** What can be sent from a lead: everything this person can see that is cleared to share. */
export async function getShareOptions(user: TokenPayload) {
  const projects = await p.project.findMany({
    where: {
      ...(await buildProjectScope(user)),
      is_published: true,
      verification_status: 'VERIFIED',
      status: { not: 'CANCELLED' },
    },
    select: { id: true, name: true, location: true },
    orderBy: { name: 'asc' },
  });
  const properties = await p.property.findMany({
    where: {
      ...(await buildPropertyScope(user)),
      status: 'LIVE',
      publications: { some: { is_published: true } },
    },
    select: { id: true, title: true, location: true },
    orderBy: { title: 'asc' },
    take: 300,
  });
  return {
    options: [
      ...projects.map((r: any) => ({
        kind: 'PROJECT',
        id: r.id,
        title: r.name,
        location: r.location,
      })),
      ...properties.map((r: any) => ({
        kind: 'PROPERTY',
        id: r.id,
        title: r.title,
        location: r.location,
      })),
    ],
  };
}

async function visibleLead(user: TokenPayload, leadId: number) {
  const lead = await p.lead.findFirst({
    where: { AND: [{ id: leadId }, await buildLeadScope(user)] },
    select: { id: true, customer_name: true, phone: true, lead_code: true },
  });
  if (!lead) throw new AppError(404, 'Lead not found, or you do not have access to it');
  return lead;
}

function buildDetailsText(content: ShareContent, sections: Sections) {
  const lines: string[] = [];
  if (sections.location && content.location) lines.push(`📍 ${content.location}`);
  if (sections.price && content.price_label) {
    lines.push(`💰 Starting from ${content.price_label} (exact cost sheet on request)`);
  }
  if (content.rera_number) lines.push(`RERA No: ${content.rera_number}`);
  if (sections.brochure) {
    // A stored path with no site address would not open on the customer's phone.
    for (const b of content.brochures) {
      if (/^https?:\/\//i.test(b.url)) lines.push(`📄 ${b.title}: ${b.url}`);
    }
  }
  return lines.join('\n');
}

export async function createShareLink(
  user: TokenPayload,
  input: { kind: ShareKind; id: number; lead_id?: number; sections: Sections },
  // The CRM site the person is using, so the link goes to the right place on
  // production and staging alike. Only their own message is affected by this value.
  origin?: string,
) {
  const content = await loadForUser(user, input.kind, input.id);
  if (content.blocked) throw new AppError(400, content.blocked);
  const lead = input.lead_id ? await visibleLead(user, input.lead_id) : null;

  const token = crypto.randomBytes(18).toString('base64url');
  const row = await p.shareLink.create({
    data: {
      token_hash: hashToken(token),
      company_id: content.company_id,
      kind: input.kind,
      target_id: input.id,
      lead_id: lead?.id ?? null,
      created_by_id: user.employeeId,
      sections: input.sections,
      expires_at: new Date(Date.now() + LINK_TTL_MS),
    },
  });
  const base = origin && /^https?:\/\/[\w.:-]+$/.test(origin) ? origin : APP_URL();
  const url = `${base}/s/${token}`;

  const [employee, company] = await Promise.all([
    p.employee.findUnique({ where: { id: user.employeeId }, select: { full_name: true } }),
    p.company.findUnique({ where: { id: content.company_id }, select: { name: true } }),
  ]);
  const message = await MessageTemplateService.resolveWithFallback('DETAILS_SHARE', {
    customer_name: lead?.customer_name || 'there',
    property_name: content.title,
    details_text: buildDetailsText(content, input.sections),
    details_link: url,
    agent_name: employee?.full_name || '',
    company_name: company?.name || '',
  });

  if (lead) {
    await p.leadActivity.create({
      data: {
        lead_id: lead.id,
        actor_id: user.employeeId,
        activity_type: 'DETAILS_SHARED',
        notes: `Shared the details of ${content.title}`,
      },
    });
  }

  return {
    link: linkSummary(row),
    url,
    text: message.body_text.replace(/\n{3,}/g, '\n\n'),
    phone: lead ? normalizeIndianPhone(lead.phone) : null,
  };
}

export async function listLeadLinks(user: TokenPayload, leadId: number) {
  await visibleLead(user, leadId);
  const links = await p.shareLink.findMany({
    where: { lead_id: leadId },
    orderBy: { id: 'desc' },
    take: 30,
  });
  return { links: links.map(linkSummary) };
}

export async function revokeShareLink(user: TokenPayload, id: number) {
  const row = await p.shareLink.findUnique({ where: { id } });
  if (!row) throw new AppError(404, 'Link not found');
  const isManager = [Roles.MD, Roles.ADMIN, Roles.TECHNICAL_MANAGER].some((r) =>
    user.roles.includes(r),
  );
  if (row.created_by_id !== user.employeeId && !isManager) {
    throw new AppError(403, 'Only the person who sent this link can turn it off');
  }
  const updated = await p.shareLink.update({
    where: { id },
    data: { revoked_at: row.revoked_at ?? new Date() },
  });
  return { link: linkSummary(updated) };
}

// ─── The customer's side: no login, the token is the only key ──────────────

async function findLiveLink(token: string) {
  if (!/^[\w-]{20,40}$/.test(token)) throw new AppError(404, 'This link is not valid.');
  const row = await p.shareLink.findUnique({ where: { token_hash: hashToken(token) } });
  if (!row) throw new AppError(404, 'This link is not valid.');
  if (row.revoked_at || row.expires_at <= new Date()) {
    throw new AppError(410, 'This link has ended. Please ask your contact for a new one.');
  }
  return row;
}

/** Who the customer should reach: the sender, or whoever has the lead if the sender has left. */
async function contactFor(row: any) {
  const select = { id: true, full_name: true, phone: true, whatsapp_number: true, status: true };
  const sender = await p.employee.findUnique({ where: { id: row.created_by_id }, select });
  if (sender?.status === 'ACTIVE') return sender;
  if (!row.lead_id) return null;
  const lead = await p.lead.findUnique({
    where: { id: row.lead_id },
    select: { assigned_to: { select } },
  });
  return lead?.assigned_to?.status === 'ACTIVE' ? lead.assigned_to : null;
}

/** Everyone who should hear about a customer's response: the sender and whoever has the lead. */
async function peopleToTell(row: any): Promise<number[]> {
  const ids = new Set<number>([row.created_by_id]);
  if (row.lead_id) {
    const lead = await p.lead.findUnique({
      where: { id: row.lead_id },
      select: { assigned_to_id: true },
    });
    if (lead?.assigned_to_id) ids.add(lead.assigned_to_id);
  }
  const active = await p.employee.findMany({
    where: { id: { in: [...ids] }, status: 'ACTIVE' },
    select: { id: true },
  });
  return active.map((e: any) => e.id);
}

async function recordResponse(row: any, type: string, title: string, message: string) {
  try {
    const lead = row.lead_id
      ? await p.lead.findUnique({
          where: { id: row.lead_id },
          select: { customer_name: true, lead_code: true },
        })
      : null;
    if (lead) {
      await p.leadActivity.create({
        data: {
          lead_id: row.lead_id,
          actor_id: row.created_by_id,
          activity_type: type,
          notes: message,
        },
      });
    }
    const who = lead ? `${lead.customer_name} (${lead.lead_code})` : 'A customer';
    const link = row.lead_id ? `/leads/${row.lead_id}` : undefined;
    for (const id of await peopleToTell(row)) {
      await notifyEmployee(id, {
        type: 'STATUS_UPDATE',
        title: `${who} ${title}`,
        message,
        ...(link ? { link } : {}),
      });
    }
  } catch (err) {
    // The customer's page must never fail because a notification did.
    logger.error({ err }, '[share] could not record a customer response');
  }
}

export async function getPublicShare(token: string, opts: { preview?: boolean } = {}) {
  const row = await findLiveLink(token);
  const content = await loadContent(row.kind, row.target_id);
  if (!content || content.blocked) {
    throw new AppError(410, 'These details are no longer available. Please ask your contact.');
  }

  if (!opts.preview) {
    const now = new Date();
    const firstOpen = !row.first_opened_at;
    const worthTelling =
      !row.last_opened_at || now.getTime() - row.last_opened_at.getTime() >= NOTIFY_AGAIN_MS;
    await p.shareLink.update({
      where: { id: row.id },
      data: {
        open_count: { increment: 1 },
        first_opened_at: row.first_opened_at ?? now,
        last_opened_at: now,
      },
    });
    if (worthTelling) {
      void recordResponse(
        row,
        'DETAILS_OPENED',
        firstOpen ? 'opened the details you shared' : 'opened your shared details again',
        `Customer opened the details of ${content.title}`,
      );
    }
  }

  const [company, contact] = await Promise.all([
    p.company.findUnique({
      where: { id: content.company_id },
      select: { name: true, legal_info: true },
    }),
    contactFor(row),
  ]);
  const legal = (company?.legal_info || {}) as Record<string, unknown>;
  return {
    ...stripInternal(content, row.sections as Sections),
    company_name: company?.name || null,
    disclaimer: (legal.website_disclaimer as string) || null,
    contact: contact
      ? { name: contact.full_name, phone: contact.whatsapp_number || contact.phone || null }
      : null,
    interested: !!row.interested_at,
  };
}

export async function markInterested(token: string) {
  const row = await findLiveLink(token);
  if (row.interested_at) return { interested: true };
  // Only the first press counts, even if two arrive together.
  const { count } = await p.shareLink.updateMany({
    where: { id: row.id, interested_at: null },
    data: { interested_at: new Date() },
  });
  if (count === 1) {
    const content = await loadContent(row.kind, row.target_id);
    await recordResponse(
      row,
      'DETAILS_INTERESTED',
      'asked for a call',
      `Customer asked for a call about ${content?.title || 'the details you shared'}`,
    );
  }
  return { interested: true };
}
