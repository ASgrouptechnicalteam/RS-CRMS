import { prisma } from '../../lib/prisma';
import { TokenPayload } from '../../utils/jwt';
import { buildLeadScope } from '../../authz/dataScope';

/**
 * Where the leads are stuck (owner, 2026-11-21).
 *
 * Every open stage is looked at, not only Qualified: how many leads sit in it, how many
 * have had no activity for longer than that stage should take, and WHY (never called, no
 * follow-up planned, no visit planned, details missing, nothing in stock that matches what
 * the customer asked for). It also shows what customers ask for against what is in stock,
 * and why leads were dropped from each stage.
 */
const p = prisma as any;

/** Open stages in order, with how many days without any activity counts as stuck. */
export const STAGES: { status: string; label: string; stuckAfterDays: number }[] = [
  { status: 'NEW', label: 'New', stuckAfterDays: 1 },
  { status: 'ASSIGNED', label: 'Assigned', stuckAfterDays: 1 },
  { status: 'CONTACTED', label: 'Contacted', stuckAfterDays: 4 },
  { status: 'QUALIFIED', label: 'Qualified', stuckAfterDays: 5 },
  { status: 'DEMO_SCHEDULED', label: 'Demo planned', stuckAfterDays: 3 },
  { status: 'DEMO_COMPLETED', label: 'Demo done', stuckAfterDays: 4 },
  { status: 'SITE_VISIT_SCHEDULED', label: 'Site visit planned', stuckAfterDays: 3 },
  { status: 'SITE_VISIT_COMPLETED', label: 'Site visit done', stuckAfterDays: 4 },
  { status: 'NEGOTIATION', label: 'Negotiation', stuckAfterDays: 7 },
  { status: 'BOOKING_INITIATED', label: 'Booking', stuckAfterDays: 5 },
];
const OPEN = STAGES.map((s) => s.status);
const DAY = 86_400_000;

export const REASONS = {
  NEVER_CALLED: 'Never called',
  NOT_CALLED_RECENTLY: 'Not called for a while',
  NO_FOLLOW_UP: 'No follow-up planned',
  NO_VISIT_PLANNED: 'No site visit planned',
  MISSING_DETAILS: 'Budget or place not known',
  NO_MATCHING_STOCK: 'Nothing in stock that matches',
} as const;
type Reason = keyof typeof REASONS;

const ACTION: Record<Reason, string> = {
  NEVER_CALLED: 'Call the customer today.',
  NOT_CALLED_RECENTLY: 'Call again and note what the customer said.',
  NO_FOLLOW_UP: 'Fix a call-back date.',
  NO_VISIT_PLANNED: 'Offer a site visit.',
  MISSING_DETAILS: 'Ask for the budget and the preferred place, then save them on the lead.',
  NO_MATCHING_STOCK:
    'Show other places or a lower price from Matching properties, or ask the digital team for new listings in this place.',
};

const norm = (v?: string | null) => (v || '').trim().toLowerCase();
const lakhs = (n: number) => `${(n / 100000).toFixed(n >= 10000000 ? 0 : 1)}L`;

const BANDS = [
  { key: 'UNDER_20L', label: 'Under 20L', max: 2_000_000 },
  { key: '20_40L', label: '20 to 40L', max: 4_000_000 },
  { key: '40_60L', label: '40 to 60L', max: 6_000_000 },
  { key: '60L_1CR', label: '60L to 1 crore', max: 10_000_000 },
  { key: 'OVER_1CR', label: 'Over 1 crore', max: Infinity },
];
const bandOf = (amount: number) => BANDS.find((b) => amount <= b.max)!;

export async function getPipelineHealth(
  user: TokenPayload,
  opts: { status?: string; employeeId?: number } = {},
) {
  const scope = await buildLeadScope(user);
  const now = Date.now();
  const where = {
    ...scope,
    status: { in: OPEN },
    ...(opts.employeeId ? { assigned_to_id: opts.employeeId } : {}),
  };
  const leads: any[] = await p.lead.findMany({
    where,
    take: 30000,
    select: {
      id: true,
      lead_code: true,
      customer_name: true,
      phone: true,
      status: true,
      created_at: true,
      assigned_at: true,
      preferred_location: true,
      budget_min: true,
      budget_max: true,
      assigned_to: { select: { id: true, full_name: true, employee_code: true } },
    },
  });

  const relation = { lead: where };
  const [lastAny, calls, tasks, visits] = await Promise.all([
    p.leadActivity.groupBy({ by: ['lead_id'], where: relation, _max: { created_at: true } }),
    p.leadActivity.groupBy({
      by: ['lead_id'],
      where: { ...relation, activity_type: 'CALL_LOGGED' },
      _max: { created_at: true },
      _count: { _all: true },
    }),
    p.task.groupBy({
      by: ['lead_id'],
      where: {
        lead: where,
        status: { in: ['PENDING', 'IN_PROGRESS', 'OVERDUE'] },
      },
      _count: { _all: true },
    }),
    p.siteVisitBooking.groupBy({
      by: ['lead_id'],
      where: { lead: where, status: { notIn: ['COMPLETED', 'CANCELLED'] } },
      _count: { _all: true },
    }),
  ]);
  const lastActivity = new Map<number, Date>(lastAny.map((r: any) => [r.lead_id, r._max.created_at]));
  const lastCall = new Map<number, Date>(calls.map((r: any) => [r.lead_id, r._max.created_at]));
  const callCount = new Map<number, number>(calls.map((r: any) => [r.lead_id, r._count._all]));
  const hasTask = new Set<number>(tasks.filter((r: any) => r.lead_id).map((r: any) => r.lead_id));
  const hasVisit = new Set<number>(visits.map((r: any) => r.lead_id));

  // What is in stock, by place: how many, and the lowest price.
  const companyId = user.companyId;
  const [props, units] = await Promise.all([
    p.property.findMany({
      where: { company_id: companyId, status: 'LIVE' },
      select: { location: true, city: true, locality: true, final_price: true },
      take: 20000,
    }),
    p.projectUnit.findMany({
      where: {
        company_id: companyId,
        sales_status: 'AVAILABLE',
        project: { verification_status: 'VERIFIED', status: { notIn: ['CANCELLED', 'ON_HOLD'] } },
      },
      select: { final_price: true, project: { select: { location: true, city: true } } },
      take: 50000,
    }),
  ]);
  const stock: { place: string; price: number }[] = [
    ...props.map((x: any) => ({
      place: norm(`${x.location} ${x.city || ''} ${x.locality || ''}`),
      price: x.final_price || 0,
    })),
    ...units.map((x: any) => ({
      place: norm(`${x.project?.location || ''} ${x.project?.city || ''}`),
      price: x.final_price || 0,
    })),
  ];
  const stockFor = (place: string) => {
    const key = norm(place);
    const hits = key ? stock.filter((s) => s.place.includes(key)) : [];
    const priced = hits.filter((h) => h.price > 0).map((h) => h.price);
    return { count: hits.length, cheapest: priced.length ? Math.min(...priced) : null };
  };

  type Row = {
    id: number;
    lead_code: string;
    customer_name: string;
    phone: string;
    status: string;
    owner: string | null;
    owner_id: number | null;
    quiet_days: number;
    calls: number;
    reasons: { key: Reason; label: string }[];
    action: string;
  };
  const stageStats = new Map<
    string,
    { open: number; stuck: number; quietDays: number; reasons: Map<Reason, number> }
  >(STAGES.map((s) => [s.status, { open: 0, stuck: 0, quietDays: 0, reasons: new Map() }]));
  const stuckRows: Row[] = [];
  const stockCache = new Map<string, ReturnType<typeof stockFor>>();
  const demand = new Map<string, { leads: number; band: Map<string, number> }>();

  for (const l of leads) {
    const stage = STAGES.find((s) => s.status === l.status)!;
    const st = stageStats.get(l.status)!;
    st.open++;
    const last = lastActivity.get(l.id) || l.assigned_at || l.created_at;
    const quiet = Math.max(0, Math.floor((now - new Date(last).getTime()) / DAY));
    st.quietDays += quiet;

    const place = (l.preferred_location || '').trim();
    if (place) {
      const d = demand.get(norm(place)) || { leads: 0, band: new Map() };
      d.leads++;
      if (l.budget_max) {
        const b = bandOf(l.budget_max).key;
        d.band.set(b, (d.band.get(b) || 0) + 1);
      }
      demand.set(norm(place), d);
    }

    if (quiet < stage.stuckAfterDays) continue;
    st.stuck++;
    const reasons: Reason[] = [];
    const called = callCount.get(l.id) || 0;
    if (!called) reasons.push('NEVER_CALLED');
    else {
      const lastCallAt = lastCall.get(l.id);
      if (lastCallAt && now - new Date(lastCallAt).getTime() > 3 * DAY)
        reasons.push('NOT_CALLED_RECENTLY');
    }
    if (!hasTask.has(l.id)) reasons.push('NO_FOLLOW_UP');
    if (
      ['QUALIFIED', 'DEMO_COMPLETED', 'NEGOTIATION'].includes(l.status) &&
      !hasVisit.has(l.id)
    )
      reasons.push('NO_VISIT_PLANNED');
    if (!place || !l.budget_max) reasons.push('MISSING_DETAILS');
    if (place) {
      if (!stockCache.has(norm(place))) stockCache.set(norm(place), stockFor(place));
      const s = stockCache.get(norm(place))!;
      if (s.count === 0 || (l.budget_max && s.cheapest && s.cheapest > l.budget_max * 1.1))
        reasons.push('NO_MATCHING_STOCK');
    }
    for (const r of reasons) st.reasons.set(r, (st.reasons.get(r) || 0) + 1);
    stuckRows.push({
      id: l.id,
      lead_code: l.lead_code,
      customer_name: l.customer_name,
      phone: l.phone,
      status: l.status,
      owner: l.assigned_to ? l.assigned_to.full_name || l.assigned_to.employee_code : null,
      owner_id: l.assigned_to?.id ?? null,
      quiet_days: quiet,
      calls: called,
      reasons: reasons.map((key) => ({ key, label: REASONS[key] })),
      action: reasons.length ? ACTION[reasons[0]] : 'Look at the lead and decide the next step.',
    });
  }

  const stages = STAGES.map((s) => {
    const st = stageStats.get(s.status)!;
    return {
      status: s.status,
      label: s.label,
      stuck_after_days: s.stuckAfterDays,
      open: st.open,
      stuck: st.stuck,
      share_stuck: st.open ? Math.round((st.stuck / st.open) * 100) : 0,
      average_quiet_days: st.open ? Math.round((st.quietDays / st.open) * 10) / 10 : 0,
      reasons: [...st.reasons.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([key, count]) => ({ key, label: REASONS[key], count })),
    };
  });

  const asked = [...demand.entries()]
    .sort((a, b) => b[1].leads - a[1].leads)
    .slice(0, 12)
    .map(([place, d]) => {
      const s = stockFor(place);
      const topBand = [...d.band.entries()].sort((a, b) => b[1] - a[1])[0];
      return {
        place,
        leads_asking: d.leads,
        in_stock: s.count,
        cheapest: s.cheapest ? lakhs(s.cheapest) : null,
        common_budget: topBand ? BANDS.find((b) => b.key === topBand[0])!.label : null,
        gap: s.count === 0,
      };
    });

  const dropped: any[] = await p.lead.groupBy({
    by: ['exited_from_status', 'exit_reason'],
    where: { ...scope, status: 'DROPPED' },
    _count: { _all: true },
  });
  const droppedFrom = STAGES.map((s) => {
    const rows = dropped.filter((d) => d.exited_from_status === s.status && d.exit_reason);
    const total = rows.reduce((n, d) => n + d._count._all, 0);
    return {
      status: s.status,
      label: s.label,
      dropped: total,
      top_reasons: rows
        .sort((a, b) => b._count._all - a._count._all)
        .slice(0, 3)
        .map((d) => ({ reason: d.exit_reason, count: d._count._all })),
    };
  }).filter((d) => d.dropped > 0);

  const list = stuckRows
    .filter((r) => !opts.status || r.status === opts.status)
    .sort((a, b) => b.quiet_days - a.quiet_days)
    .slice(0, 100);

  const worst = [...stages].filter((s) => s.stuck > 0).sort((a, b) => b.stuck - a.stuck)[0];
  return {
    generated_at: new Date().toISOString(),
    total_open: leads.length,
    total_stuck: stuckRows.length,
    biggest_gap: worst
      ? `${worst.label}: ${worst.stuck} of ${worst.open} leads have had no activity for ${worst.stuck_after_days} days or more.`
      : null,
    stages,
    asked_places: asked,
    dropped_from: droppedFrom,
    leads: list,
  };
}
