// The "Visit brief": what a PM or agent reads before a site visit. Built from CRM
// records by a fixed template. Nothing here is written by a machine: a line whose
// data is missing is left out and named in `gaps` instead. A project manager cannot
// read leads, so this builds the customer part from an explicit list of fields.
import { prisma } from '../../lib/prisma';
import { TokenPayload } from '../../utils/jwt';
import { SiteVisitPolicy } from '../../policies/siteVisit.policy';
import { buildSiteVisitScope } from '../../authz/dataScope';
import { formatPrice, loadContent, ShareContent } from '../share.service';
import { normalizeIndianPhone } from '../../utils/phone';
import { AppError } from '../lead/errors';

const p = prisma as any;

export type ReraState = 'APPROVED' | 'APPLIED' | 'NOT_APPLICABLE' | 'NOT_RECORDED';

/** The only four things the brief may say about RERA. */
export function reraWording(status?: string | null, number?: string | null) {
  const no = number?.trim() || null;
  let state: ReraState = 'NOT_RECORDED';
  if (status === 'APPLIED') state = 'APPLIED';
  else if (status === 'NOT_APPLICABLE') state = 'NOT_APPLICABLE';
  else if (no && (status === 'APPROVED' || !status)) state = 'APPROVED';
  const say: Record<ReraState, string> = {
    APPROVED: `RERA No. ${no}`,
    APPLIED:
      "RERA registration applied; number not issued yet. Say 'applied'. Do not say registered or approved.",
    NOT_APPLICABLE: 'Recorded as not applicable. Confirm with the project PM before saying so.',
    NOT_RECORDED:
      'RERA information not recorded. Do not mention a number or say the project is registered.',
  };
  return { state, number: state === 'APPROVED' ? no : null, say: say[state] };
}

const humanise = (v?: string | null) =>
  v
    ? v
        .replace(/_/g, ' ')
        .toLowerCase()
        .replace(/^\w/, (c) => c.toUpperCase())
    : null;

const dateText = (d?: Date | null) =>
  d
    ? d.toLocaleDateString('en-IN', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: 'Asia/Kolkata',
      })
    : null;

/** A template line. Returns null when any {token} has no value, so nothing is ever guessed. */
export function fill(template: string, tokens: Record<string, string | null | undefined>) {
  let missing = false;
  const out = template.replace(/\{(\w+)\}/g, (_m, key) => {
    const v = tokens[key];
    if (v === null || v === undefined || !String(v).trim()) {
      missing = true;
      return '';
    }
    return String(v).trim();
  });
  return missing ? null : out;
}
const lines = (list: (string | null)[]) => list.filter((l): l is string => !!l);

// Text the system or the booking form fills in when the telecaller wrote nothing.
const FILLER_NOTES = [
  'Site visit booked by telecaller.',
  'Telecaller booked site visit for client discussion.',
];

interface PriceInfo {
  text: string;
  as_of: string | null;
  from: boolean;
}
const priceInfo = (amount?: number | null, at?: Date | null, from = false): PriceInfo | null => {
  const text = formatPrice(amount);
  return text ? { text, as_of: dateText(at), from } : null;
};
const priceSentence = (name: string, pr: PriceInfo | null) =>
  pr
    ? pr.from
      ? fill('Prices at {name} start from {price}{asof}.', {
          name,
          price: pr.text,
          asof: pr.as_of ? ` (as of ${pr.as_of})` : ' (date of price not recorded)',
        })
      : fill('The price for {name} is {price}{asof}.', {
          name,
          price: pr.text,
          asof: pr.as_of ? ` (as of ${pr.as_of})` : ' (date of price not recorded)',
        })
    : null;

const budgetText = (min?: number | null, max?: number | null, reqMax?: number | null) => {
  const hi = max && max > 0 ? max : reqMax && reqMax > 0 ? reqMax : null;
  const lo = min && min > 0 ? min : null;
  if (lo && hi) return `${formatPrice(lo)} to ${formatPrice(hi)}`;
  if (hi) return `up to ${formatPrice(hi)}`;
  if (lo) return `from ${formatPrice(lo)}`;
  return null;
};

const phoneLink = (phone?: string | null) => {
  if (!phone) return null;
  try {
    return normalizeIndianPhone(phone) || null;
  } catch {
    return null;
  }
};

export async function getVisitBrief(user: TokenPayload, visitId: number) {
  // Same visibility as the visit list (authz/dataScope buildSiteVisitScope).
  const visit = await p.siteVisitBooking.findFirst({
    where: { AND: [await buildSiteVisitScope(user), { id: visitId }] },
    include: {
      lead: {
        select: {
          id: true,
          company_id: true,
          customer_name: true,
          phone: true,
          property_type_preference: true,
          budget_min: true,
          budget_max: true,
          preferred_location: true,
          matching_requirement: {
            select: { property_type: true, location: true, max_budget: true, min_bedrooms: true },
          },
          preferred_locations: { select: { location: true }, orderBy: { sort_order: 'asc' } },
        },
      },
      telecaller: { select: { full_name: true, phone: true } },
      project_manager: { select: { full_name: true, phone: true } },
      assigned_agent: { select: { full_name: true, phone: true } },
      project: { select: { id: true, name: true } },
      site_visit_properties: {
        select: { property_id: true, project_unit_id: true },
        orderBy: { id: 'asc' },
      },
    },
  });
  if (!visit) throw new AppError(404, 'Site visit not found, or you do not have access to it');

  const companyId: number = visit.lead.company_id;
  // Blind approval: until the PM accepts, nobody but the booking telecaller and
  // MD / Admin / Marketing Director sees who the customer is (same rule as the list).
  const customerHidden =
    visit.status === 'PENDING_ACCEPTANCE' &&
    visit.telecaller_id !== user.employeeId &&
    !SiteVisitPolicy.canViewReassignmentReason(user);

  const gaps: string[] = [];
  const generatedAt = new Date();

  // ---- linked units / properties (several allowed) ----
  const unitIds: number[] = [];
  const propertyIds: number[] = [];
  for (const row of visit.site_visit_properties) {
    if (row.project_unit_id && !unitIds.includes(row.project_unit_id))
      unitIds.push(row.project_unit_id);
    if (row.property_id && !propertyIds.includes(row.property_id))
      propertyIds.push(row.property_id);
  }
  if (!unitIds.length && visit.project_unit_id) unitIds.push(visit.project_unit_id);
  if (!propertyIds.length && !unitIds.length && visit.property_id)
    propertyIds.push(visit.property_id);

  const unitRows: any[] = unitIds.length
    ? await p.projectUnit.findMany({
        where: { id: { in: unitIds }, company_id: companyId },
        select: {
          id: true,
          project_id: true,
          unit_number: true,
          unit_type: true,
          final_price: true,
          price_computed_at: true,
          sales_status: true,
        },
      })
    : [];
  const propertyRows: any[] = propertyIds.length
    ? await p.property.findMany({
        where: { id: { in: propertyIds }, company_id: companyId },
        select: {
          id: true,
          project_id: true,
          final_price: true,
          price_computed_at: true,
          sales_status: true,
        },
      })
    : [];

  const projectId: number | null =
    visit.project_id ??
    unitRows[0]?.project_id ??
    propertyRows.find((r) => r.project_id)?.project_id ??
    null;

  // ---- project block, once ----
  let project: any = null;
  let projectContent: ShareContent | null = null;
  if (projectId) {
    projectContent = await loadContent('PROJECT', projectId, { company_id: companyId });
    if (projectContent) {
      const rera = reraWording(projectContent.rera_status, projectContent.rera_number);
      const fromUnit = await p.projectUnit.findFirst({
        where: {
          project_id: projectId,
          is_published: true,
          sales_status: 'AVAILABLE',
          final_price: { gt: 0 },
        },
        orderBy: { final_price: 'asc' },
        select: { final_price: true, price_computed_at: true },
      });
      const projectRow = await p.project.findFirst({
        where: { id: projectId },
        select: { status: true, maps_link: true },
      });
      project = {
        id: projectId,
        name: projectContent.title,
        status: humanise(projectRow?.status),
        description: projectContent.description?.trim().slice(0, 500) || null,
        location: projectContent.location?.trim() || null,
        address: projectContent.address,
        maps_link: projectRow?.maps_link || null,
        amenities: projectContent.amenities,
        rera,
        price_from: priceInfo(fromUnit?.final_price, fromUnit?.price_computed_at, true),
        brochures: projectContent.brochures,
        cannot_share_reason: projectContent.blocked,
        warnings: projectContent.warnings,
      };
      if (!project.location) gaps.push(`${project.name}: location not recorded`);
      if (!project.amenities.length) gaps.push(`${project.name}: no amenities recorded`);
      if (rera.state === 'NOT_RECORDED')
        gaps.push(`${project.name}: RERA status or number not recorded`);
      if (!project.price_from && !unitRows.length)
        gaps.push(`${project.name}: no available unit has a price set`);
    }
  }

  // ---- unit and property cards ----
  const items: any[] = [];
  for (const u of unitRows) {
    const c = await loadContent('UNIT', u.id, { company_id: companyId });
    if (!c) continue;
    const available = u.sales_status === 'AVAILABLE';
    let alternatives: any[] = [];
    if (!available) {
      const alts = await p.projectUnit.findMany({
        where: {
          project_id: u.project_id,
          unit_type: u.unit_type,
          sales_status: 'AVAILABLE',
          is_published: true,
          id: { notIn: unitIds },
        },
        select: { id: true, unit_number: true, final_price: true, price_computed_at: true },
        orderBy: { final_price: 'asc' },
        take: 3,
      });
      alternatives = alts.map((a: any) => ({
        title: `Unit ${a.unit_number}`,
        price: priceInfo(a.final_price, a.price_computed_at),
      }));
    }
    const price = priceInfo(u.final_price, u.price_computed_at);
    if (!price) gaps.push(`${c.title}: price not set`);
    else if (!price.as_of) gaps.push(`${c.title}: date of the price not recorded`);
    items.push({
      kind: 'UNIT',
      id: u.id,
      title: c.title,
      facts: c.facts,
      price,
      availability: {
        available,
        text: available ? 'Available' : `No longer available (${humanise(u.sales_status)})`,
      },
      alternatives,
      standalone: null,
    });
  }
  for (const r of propertyRows) {
    const c = await loadContent('PROPERTY', r.id, { company_id: companyId });
    if (!c) continue;
    const under = !!projectId && r.project_id === projectId;
    const available = r.sales_status === 'AVAILABLE';
    const price = priceInfo(r.final_price, r.price_computed_at);
    if (!price) gaps.push(`${c.title}: price not set`);
    else if (!price.as_of) gaps.push(`${c.title}: date of the price not recorded`);
    let standalone: any = null;
    if (!under) {
      const rera = reraWording(c.rera_status, c.rera_number);
      standalone = {
        location: c.location?.trim() || null,
        address: c.address,
        amenities: c.amenities,
        rera,
        cannot_share_reason: c.blocked,
      };
      if (!standalone.location) gaps.push(`${c.title}: location not recorded`);
      if (!c.amenities.length) gaps.push(`${c.title}: no amenities recorded`);
      if (rera.state === 'NOT_RECORDED')
        gaps.push(`${c.title}: RERA not recorded for this property`);
    }
    items.push({
      kind: 'PROPERTY',
      id: r.id,
      title: c.title,
      facts: c.facts,
      price,
      availability: {
        available,
        text: available ? 'Available' : `No longer available (${humanise(r.sales_status)})`,
      },
      alternatives: [],
      standalone,
    });
  }
  if (!items.length && !project) {
    gaps.push('No property, unit or project is linked to this visit. Ask the telecaller.');
  }

  // ---- customer part ----
  let customer: any = null;
  const lead = visit.lead;
  const runner = visit.assigned_agent?.full_name || visit.project_manager?.full_name || null;
  if (!customerHidden) {
    const [calls, previous] = await Promise.all([
      p.leadActivity.findMany({
        where: { lead_id: lead.id, activity_type: 'CALL_LOGGED' },
        orderBy: { created_at: 'desc' },
        take: 3,
        select: { call_outcome: true, call_reason: true, created_at: true },
      }),
      p.siteVisitBooking.findMany({
        where: { lead_id: lead.id, id: { not: visit.id } },
        orderBy: { scheduled_date: 'desc' },
        take: 5,
        select: {
          booking_code: true,
          scheduled_date: true,
          status: true,
          rating: true,
          project: { select: { name: true } },
        },
      }),
    ]);
    const locations: string[] = [
      ...new Set<string>(
        [
          ...lead.preferred_locations.map((l: any) => l.location),
          lead.preferred_location,
          lead.matching_requirement?.location,
        ]
          .map((s: any) => (typeof s === 'string' ? s.trim() : ''))
          .filter(Boolean),
      ),
    ];
    const req = lead.matching_requirement;
    const reqParts = lines([
      humanise(lead.property_type_preference || req?.property_type),
      req?.min_bedrooms ? `${req.min_bedrooms}+ bedrooms` : null,
    ]);
    const budget = budgetText(lead.budget_min, lead.budget_max, req?.max_budget);
    const bookingNote =
      visit.verification_call_notes && !FILLER_NOTES.includes(visit.verification_call_notes.trim())
        ? visit.verification_call_notes.trim()
        : null;
    const tellThePm = visit.customer_brief?.trim() || null;
    if (!budget) gaps.push('Customer budget not recorded');
    if (!reqParts.length) gaps.push('What the customer is looking for is not recorded');
    if (!locations.length) gaps.push('Customer preferred location not recorded');
    if (!bookingNote && !tellThePm) gaps.push('No note from the telecaller');
    customer = {
      name: lead.customer_name || null,
      first_name: (lead.customer_name || '').trim().split(/\s+/)[0] || null,
      phone: lead.phone || null,
      whatsapp_phone: phoneLink(lead.phone),
      budget,
      requirement: reqParts.join(', ') || null,
      preferred_locations: locations,
      tell_the_pm: tellThePm,
      telecaller_note: bookingNote,
      telecaller: visit.telecaller
        ? { name: visit.telecaller.full_name, phone: visit.telecaller.phone || null }
        : null,
      last_calls: calls.map((c: any) => ({
        at: c.created_at,
        outcome: humanise(c.call_outcome),
        reason: humanise(c.call_reason),
      })),
      previous_visits: previous.map((v: any) => ({
        booking_code: v.booking_code,
        date: v.scheduled_date,
        status: humanise(v.status),
        rating: humanise(v.rating),
        project: v.project?.name || null,
      })),
    };
  }

  // ---- the spoken script (fixed template; a line with missing data is dropped) ----
  const firstItem = items[0];
  const placeName = project?.name || firstItem?.title || null;
  const opening = lines([
    fill('Hello {name}, welcome to {place}.', { name: customer?.first_name, place: placeName }),
    fill('I am {runner}, and I will be showing you around today.', { runner }),
    fill('You are looking for {req}.', { req: customer?.requirement }),
    fill('Your preferred area is {loc}.', { loc: customer?.preferred_locations?.join(', ') }),
    fill('Your budget is {budget}.', { budget: customer?.budget }),
  ]);
  const unitLines = items.flatMap((it) => [
    it.facts.length
      ? fill('{title}: {facts}.', {
          title: it.title,
          facts: it.facts.map((f: any) => `${f.label} ${f.value}`).join(', '),
        })
      : null,
    priceSentence(it.title, it.price),
    it.availability.available
      ? null
      : fill('{title} is not available any more.', { title: it.title }),
  ]);
  const place = project || firstItem?.standalone;
  const pitch = lines([
    fill('{name} is in {loc}.', { name: placeName, loc: place?.location }),
    fill('The amenities recorded are: {list}.', {
      list: place?.amenities?.slice(0, 8).join(', '),
    }),
    fill('Current stage: {stage}.', { stage: project?.status }),
    ...unitLines,
    items.length ? null : priceSentence(placeName || '', project?.price_from ?? null),
    fill('{say}', { say: place?.rera?.say }),
  ]);
  const firstPrice = items.find((i) => i.price)?.price ?? project?.price_from ?? null;
  const objections = [
    {
      question: 'The price is too high',
      answer: lines([
        priceSentence(placeName || 'this property', firstPrice),
        'The full cost sheet is shared in writing, so you can see every part of the price.',
      ]).join(' '),
    },
    {
      question: 'The location is too far',
      answer: lines([
        fill('{name} is in {loc}.', { name: placeName, loc: place?.location }),
        project?.maps_link ? 'I can show you the route on the map now.' : null,
        'Please tell me the places you travel to often, and I will note them down.',
      ]).join(' '),
    },
    {
      question: 'Are the approvals clear?',
      answer: place?.rera?.say || '',
    },
    {
      question: 'When can we move in?',
      answer:
        fill(
          'The recorded stage is: {stage}. I will confirm dates with the project team in writing.',
          {
            stage: project?.status,
          },
        ) || 'I will confirm the dates with the project team in writing.',
    },
    {
      question: 'I want to compare with other places',
      answer:
        'Of course. Please take notes on price, location and approvals, and ask me anything you want checked.',
    },
    {
      question: 'I need to discuss with my family',
      answer: 'Take your time. If you wish, we can plan a second visit with your family.',
    },
    {
      question: 'What about a home loan?',
      answer: 'I will check with the project team about loan options and tell you.',
    },
  ].filter((o) => o.answer.trim());
  const close = [
    'Ask what they liked and what worries them.',
    'When the visit ends, record whether they are interested in each property.',
    'If they are not interested, ask why. The reason is needed to complete the visit.',
    'Send the feedback link after the visit.',
  ];

  return {
    visit: {
      id: visit.id,
      booking_code: visit.booking_code,
      scheduled_date: visit.scheduled_date,
      status: visit.status,
      visit_type: visit.visit_type,
      runner,
      project_manager: visit.project_manager
        ? { name: visit.project_manager.full_name, phone: visit.project_manager.phone || null }
        : null,
      pick_up: customerHidden
        ? null
        : visit.pick_up_requested
          ? { address: visit.pick_up_address || null }
          : null,
    },
    customer_hidden: customerHidden,
    customer,
    project,
    items,
    script: { opening, pitch, objections, close },
    gaps,
    generated_at: generatedAt.toISOString(),
    footer:
      'Source: CRM records at the time shown. If anything here looks wrong, tell the project PM.',
  };
}

/** Records that the brief was opened (tracked, never required). Once per person per visit. */
export async function recordBriefOpened(user: TokenPayload, visitId: number) {
  const visit = await p.siteVisitBooking.findFirst({
    where: { AND: [await buildSiteVisitScope(user), { id: visitId }] },
    select: { booking_code: true, lead_id: true, status: true, telecaller_id: true },
  });
  if (!visit) return;
  const notes = `Visit brief opened for ${visit.booking_code}.`;
  const already = await p.leadActivity.findFirst({
    where: {
      lead_id: visit.lead_id,
      actor_id: user.employeeId,
      activity_type: 'SITE_VISIT_BRIEF_VIEWED',
      notes,
    },
    select: { id: true },
  });
  if (already) return;
  await p.leadActivity.create({
    data: {
      lead_id: visit.lead_id,
      actor_id: user.employeeId,
      activity_type: 'SITE_VISIT_BRIEF_VIEWED',
      notes,
    },
  });
}
