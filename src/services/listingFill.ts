/**
 * Fills the EMPTY details of an existing project or property from a new listing (owner, 2026-11-27): the listing
 * asks for things the project form does not (sizes, BHK types, prices per unit...). Nothing already typed in the
 * record is ever changed. These functions only work out what would be filled; DraftService saves it.
 */
import { listingFieldsFor, listingProjectGroup } from '../shared';
import { hasBhk } from './projectFacts';

export interface Blank {
  label: string;
  value: string;
}
export interface FillPlan {
  items: Blank[];
  data: Record<string, unknown>;
}

const APPROVALS = [
  'RERA',
  'DTCP',
  'HMDA',
  'GHMC',
  'MUDA',
  'YTDA',
  'KUDA',
  'WUDA',
  'HYDRAA',
  'GRAM_PANCHAYAT',
  'MUNICIPALITY',
];
const PAYMENT = [
  ['pay_booking_amount', 'booking_amount', 'Booking amount'],
  ['pay_booking_when', 'booking_when', 'Booking amount is paid'],
  ['pay_allotment_amount', 'allotment_amount', 'Allotment amount'],
  ['pay_allotment_when', 'allotment_when', 'Allotment amount is paid'],
  ['pay_final_amount', 'final_amount', 'Final payment'],
  ['pay_final_when', 'final_when', 'Final payment is paid'],
  ['pay_discount', 'discount', 'Discount for paying on time'],
] as const;

const empty = (v: unknown) =>
  v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
const number = (v: unknown) => (typeof v === 'number' && v > 0 ? v : null);
const words = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const shown = (n: number) => n.toLocaleString('en-IN');
const objectOf = (raw: unknown): Record<string, any> => {
  if (raw && typeof raw === 'object') return raw as Record<string, any>;
  if (typeof raw === 'string') {
    try {
      const v = JSON.parse(raw);
      return v && typeof v === 'object' ? v : {};
    } catch {
      return {};
    }
  }
  return {};
};

const range = (min: unknown, max: unknown, unit: string) => {
  const a = number(min);
  const b = number(max);
  if (a && b) return a === b ? `${shown(a)} ${unit}` : `${shown(a)} – ${shown(b)} ${unit}`;
  if (a) return `From ${shown(a)} ${unit}`;
  if (b) return `Up to ${shown(b)} ${unit}`;
  return null;
};

/** The sizes as one line, in the unit that kind of project is measured in. */
function sizesOf(projectType: string, d: Record<string, unknown>): string | null {
  const group = listingProjectGroup(projectType);
  if (group === 'HOUSES') {
    const built = range(d.built_up_min, d.built_up_max, 'sq ft');
    const plots = range(d.unit_size_min, d.unit_size_max, 'sq yd');
    if (built && plots) return `${built} built-up; plots ${plots}`;
    return built ? `${built} built-up` : plots ? `Plots ${plots}` : null;
  }
  const unit = group === 'LAYOUT' ? 'sq yd' : group === 'FARM' ? 'guntas' : 'sq ft';
  return range(d.unit_size_min, d.unit_size_max, unit);
}

/** "2, 3 BHK" or "2 BHK / 3 BHK" as separate types. */
function bhkTypesOf(text: unknown) {
  return [
    ...new Set(
      String(text ?? '')
        .split(/[,/&]|\band\b/i)
        .map((x) => x.trim())
        .filter(Boolean)
        .map((x) => (/^\d+(\.\d+)?\+?$/.test(x) ? `${x} BHK` : x.replace(/bhk/i, 'BHK')))
        .map((x) => x.slice(0, 20)),
    ),
  ].slice(0, 12);
}

/** Listing details with no box of their own (rates per sq yd and so on), as lines for an empty description. */
function noteLines(type: 'PROPERTY' | 'PROJECT', kind: string, d: Record<string, unknown>) {
  const keys = [
    'price_per_sqyd',
    'price_per_sqft',
    'price_per_acre',
    'expected_price',
    'water_source',
  ];
  return listingFieldsFor(type, kind)
    .filter((f) => keys.includes(f.key) && !empty(d[f.key]))
    .map((f) => {
      const raw = d[f.key];
      const value = typeof raw === 'number' ? shown(raw) : String(raw);
      return f.unit?.startsWith('₹')
        ? `${f.label}: ₹${value}${f.unit.slice(1)}`
        : `${f.label}: ${value}`;
    });
}

/** Collects the empty boxes the listing has something for. */
function planner() {
  const items: Blank[] = [];
  const data: Record<string, unknown> = {};
  return {
    items,
    data,
    fill(current: unknown, next: unknown, column: string, label: string, text?: string) {
      if (!empty(current) || empty(next)) return;
      data[column] = next;
      items.push({ label, value: text ?? String(next) });
    },
  };
}

export function projectFill(draft: any, project: any): FillPlan {
  const extra = objectOf(draft.extra);
  const d = objectOf(extra.details);
  const type = String(project.project_type || draft.project_type || '');
  const plan = planner();
  const { fill, items, data } = plan;

  fill(project.project_type, draft.project_type, 'project_type', 'Project type');
  fill(project.developer_name, words(draft.developer_name), 'developer_name', 'Developer');
  fill(project.city, words(draft.city), 'city', 'City');
  fill(project.maps_link, words(extra.maps_link), 'maps_link', 'Map link');
  // Residential plots have an LP number, not a RERA number (owner, 2026-11-21): the project form clears it there.
  if (listingProjectGroup(type) !== 'LAYOUT')
    fill(project.rera_number, words(extra.rera_number), 'rera_number', 'RERA number');
  const launch = words(extra.launch_date) ? new Date(String(extra.launch_date)) : null;
  if (launch && !isNaN(launch.getTime()))
    fill(project.launch_date, launch, 'launch_date', 'Launch date', String(extra.launch_date));

  const acres = number(d.total_land_acres);
  if (acres && empty(project.total_area_value) && empty(project.total_area)) {
    data.total_area_value = acres;
    data.total_area_unit = 'ACRE';
    items.push({ label: 'Total area', value: `${shown(acres)} acres` });
  }
  fill(project.towers_count, number(d.towers), 'towers_count', 'Towers / blocks');
  fill(project.floors_count, number(d.floors), 'floors_count', 'Floors');

  const approvals = String(d.approval ?? '')
    .split(/[,/&+]|\band\b/i)
    .map((x) => x.trim().toUpperCase().replace(/\s+/g, '_'))
    .filter((x) => APPROVALS.includes(x));
  if (approvals.length && empty(project.approval_authority))
    fill(
      project.approval_authorities,
      [...new Set(approvals)],
      'approval_authorities',
      'Approved by',
      [...new Set(approvals)].join(', ').replace(/_/g, ' '),
    );

  if (typeof d.bank_loan_available === 'boolean')
    fill(
      project.bank_loan_available,
      d.bank_loan_available,
      'bank_loan_available',
      'Bank loan available',
      d.bank_loan_available ? 'Yes' : 'No',
    );

  // The typed "Project information" boxes (the project form has none of these).
  const key = objectOf(project.key_details);
  const nextKey: Record<string, unknown> = { ...key };
  const setKey = (name: string, next: unknown, label: string, text: string) => {
    if (!empty(key[name]) || empty(next)) return;
    nextKey[name] = next;
    items.push({ label, value: text });
  };
  // The number sits in two places (the project form and "Project information"), listed to the reader once.
  const group = listingProjectGroup(type);
  const thing =
    group === 'LAYOUT' || group === 'FARM' ? 'plot' : group === 'FLATS' ? 'flat' : 'unit';
  const units = number(d.total_units);
  const formUnits = !!units && empty(project.total_units);
  if (formUnits) data.total_units = units;
  // Never fewer than the number already marked as available.
  const keyUnits =
    !!units && units <= 100000 && empty(key.units_total) && !(Number(key.units_available) > units);
  if (keyUnits) nextKey.units_total = units;
  if (formUnits || keyUnits) items.push({ label: `Number of ${thing}s`, value: shown(units!) });
  const sizes = sizesOf(type, d);
  setKey('sizes', sizes, `${thing[0].toUpperCase()}${thing.slice(1)} sizes`, sizes ?? '');
  if (hasBhk(type)) {
    const bhk = bhkTypesOf(d.bhk_types);
    setKey(
      'bhk_types',
      bhk.map((x) => ({ bhk: x, total: null, available: null })),
      'BHK types',
      bhk.join(', '),
    );
  }
  if (Object.keys(nextKey).some((k) => nextKey[k] !== key[k])) data.key_details = nextKey;

  const pay = objectOf(project.payment_terms);
  const nextPay: Record<string, unknown> = { ...pay };
  for (const [from, to, label] of PAYMENT) {
    // The project form takes 200 letters for each "when" and 400 for the discount.
    const value = to.endsWith('amount')
      ? number(d[from])
      : (words(d[from])?.slice(0, to === 'discount' ? 400 : 200) ?? null);
    if (!empty(pay[to]) || value === null) continue;
    nextPay[to] = value;
    items.push({ label, value: typeof value === 'number' ? `₹${shown(value)}` : value });
  }
  if (Object.keys(nextPay).some((k) => nextPay[k] !== pay[k])) data.payment_terms = nextPay;

  const description = [words(extra.description), noteLines('PROJECT', type, d).join('\n') || null]
    .filter(Boolean)
    .join('\n\n');
  fill(project.description, description, 'description', 'Description');
  return { items, data };
}

export function propertyFill(draft: any, property: any): FillPlan {
  const extra = objectOf(draft.extra);
  const d = objectOf(extra.details);
  const plan = planner();
  const { fill, items, data } = plan;

  fill(property.city, words(draft.city), 'city', 'City');
  fill(property.facing, words(d.facing), 'facing', 'Facing', String(d.facing).replace(/_/g, '-'));
  const bedrooms = Math.floor(parseFloat(String(d.bhk ?? '')));
  if (bedrooms > 0) fill(property.bedrooms, bedrooms, 'bedrooms', 'Bedrooms');
  const sized: [string, string, string, unknown][] = [
    ['plot_area_sqyd', 'Plot area', 'sq yd', d.plot_area_sqyd],
    ['plot_length_ft', 'Plot length', 'ft', d.plot_length_ft],
    ['plot_width_ft', 'Plot width', 'ft', d.plot_width_ft],
    ['road_width_ft', 'Road width', 'ft', d.road_width_ft],
    ['built_up_area_sqft', 'Built-up area', 'sq ft', d.built_up_area_sqft],
    ['carpet_area_sqft', 'Carpet area', 'sq ft', d.carpet_area_sqft],
  ];
  for (const [column, label, unit, raw] of sized) {
    const n = number(raw);
    if (n) fill(property[column], n, column, label, `${shown(n)} ${unit}`);
  }
  fill(
    property.total_floors,
    number(d.total_floors ?? d.floors),
    'total_floors',
    'Floors in the building',
  );
  const acres = (number(d.land_acres) ?? 0) + (number(d.land_guntas) ?? 0) / 40;
  if (acres > 0 && empty(property.area_value)) {
    data.area_value = Math.round(acres * 1000) / 1000;
    data.area_unit = 'ACRE';
    items.push({ label: 'Land', value: `${shown(data.area_value as number)} acres` });
  }
  const sqft = number(draft.area_sqft);
  if (sqft && !property.area_sqft) {
    data.area_sqft = sqft;
    items.push({ label: 'Area', value: `${shown(sqft)} sq ft` });
  }
  const description = [
    words(extra.description),
    noteLines('PROPERTY', String(draft.category || ''), d).join('\n') || null,
  ]
    .filter(Boolean)
    .join('\n\n');
  fill(property.description, description, 'description', 'Description');
  return { items, data };
}
