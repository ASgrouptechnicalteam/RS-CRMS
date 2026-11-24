// New listings (a PM or an external CP hands the digital team a property or a
// project they found). The fields asked change with the property category or
// the project type: a plot is measured in sq yd, farm land in acres and
// guntas, a flat in sq ft with its BHK, and so on (owner, 2026-11-15).
//
// One list drives the form (web), the server's checks and the hand-off to the
// real Properties / Projects form. Keep this file identical in
// apps/api/src/shared/listingFields.ts and packages/shared/src/listingFields.ts,
// and the copy at the end of apps/web/src/shared/index.ts.

export type ListingFieldKind = 'number' | 'text' | 'select' | 'yesno';

export interface ListingField {
  key: string;
  label: string;
  kind: ListingFieldKind;
  /** shown after the box, e.g. "sq yd" */
  unit?: string;
  required?: boolean;
  options?: { value: string; label: string }[];
  /** whole numbers only */
  integer?: boolean;
  placeholder?: string;
}

export const LISTING_FACING = [
  { value: 'EAST', label: 'East' },
  { value: 'WEST', label: 'West' },
  { value: 'NORTH', label: 'North' },
  { value: 'SOUTH', label: 'South' },
  { value: 'NORTH_EAST', label: 'North-East' },
  { value: 'NORTH_WEST', label: 'North-West' },
  { value: 'SOUTH_EAST', label: 'South-East' },
  { value: 'SOUTH_WEST', label: 'South-West' },
];

export const LISTING_BHK = [
  '1 RK',
  '1 BHK',
  '1.5 BHK',
  '2 BHK',
  '2.5 BHK',
  '3 BHK',
  '3.5 BHK',
  '4 BHK',
  '4.5 BHK',
  '5 BHK',
  '5+ BHK',
].map((v) => ({ value: v, label: v }));

export const LISTING_PROPERTY_CATEGORIES = [
  { value: 'PLOT', label: 'Residential plot' },
  { value: 'APARTMENT', label: 'Apartment / flat' },
  { value: 'VILLA', label: 'Villa' },
  { value: 'INDEPENDENT_HOUSE', label: 'Independent house' },
  { value: 'DUPLEX', label: 'Duplex' },
  { value: 'INDEPENDENT_FLOOR', label: 'Independent floor' },
  { value: 'PENTHOUSE', label: 'Penthouse' },
  { value: 'STUDIO', label: 'Studio / 1 RK' },
  { value: 'AGRICULTURAL_LAND', label: 'Agricultural / farm land' },
  { value: 'FARM_HOUSE', label: 'Farm house' },
  { value: 'COMMERCIAL_SHOP', label: 'Commercial shop' },
  { value: 'COMMERCIAL_OFFICE', label: 'Commercial office' },
];

export const LISTING_PROJECT_TYPES = [
  { value: 'PLOTTED', label: 'Plotted layout' },
  { value: 'RESIDENTIAL_PLOTS', label: 'Residential plots' },
  { value: 'APARTMENT', label: 'Apartments / flats' },
  { value: 'VILLA', label: 'Villas' },
  { value: 'INDEPENDENT_HOUSE', label: 'Independent houses' },
  { value: 'ROW_HOUSE', label: 'Row houses' },
  { value: 'GATED_COMMUNITY', label: 'Gated community' },
  { value: 'AGRICULTURAL_LAND', label: 'Agricultural / farm land' },
  { value: 'FARM_HOUSE', label: 'Farm houses' },
  { value: 'COMMERCIAL_SHOP', label: 'Commercial shops' },
  { value: 'COMMERCIAL_OFFICE', label: 'Commercial offices' },
  { value: 'MIXED_USE', label: 'Mixed use' },
  { value: 'TOWNSHIP', label: 'Township' },
  { value: 'OTHER', label: 'Other' },
];

const num = (
  key: string,
  label: string,
  unit?: string,
  extra: Partial<ListingField> = {},
): ListingField => ({ key, label, kind: 'number', unit, ...extra });
const facing: ListingField = {
  key: 'facing',
  label: 'Facing',
  kind: 'select',
  options: LISTING_FACING,
};
const bhk = (required = true): ListingField => ({
  key: 'bhk',
  label: 'BHK',
  kind: 'select',
  options: LISTING_BHK,
  required,
});

export type ListingPropertyGroup = 'PLOT' | 'FARM' | 'FLAT' | 'HOUSE' | 'FLOOR' | 'COMMERCIAL';

export const listingPropertyGroup = (category: string): ListingPropertyGroup => {
  if (category === 'PLOT') return 'PLOT';
  if (category === 'AGRICULTURAL_LAND' || category === 'FARM_HOUSE') return 'FARM';
  if (['APARTMENT', 'PENTHOUSE', 'STUDIO'].includes(category)) return 'FLAT';
  if (category === 'INDEPENDENT_FLOOR') return 'FLOOR';
  if (category === 'COMMERCIAL_SHOP' || category === 'COMMERCIAL_OFFICE') return 'COMMERCIAL';
  return 'HOUSE'; // VILLA, INDEPENDENT_HOUSE, DUPLEX
};

/** The details asked for a property, by its category. */
export const LISTING_PROPERTY_FIELDS: Record<ListingPropertyGroup, ListingField[]> = {
  PLOT: [
    num('plot_area_sqyd', 'Plot area', 'sq yd', { required: true }),
    num('plot_length_ft', 'Length', 'ft'),
    num('plot_width_ft', 'Width', 'ft'),
    facing,
    num('road_width_ft', 'Road in front', 'ft'),
    { key: 'is_corner', label: 'Corner plot', kind: 'yesno' },
    num('price_per_sqyd', 'Asking price', '₹ per sq yd'),
  ],
  FARM: [
    num('land_acres', 'Land', 'acres'),
    num('land_guntas', 'and', 'guntas', { integer: true }),
    num('built_up_area_sqft', 'Farm house built-up', 'sq ft'),
    num('road_width_ft', 'Road access width', 'ft'),
    { key: 'water_source', label: 'Water source', kind: 'text', placeholder: 'Bore well, canal…' },
    num('price_per_acre', 'Asking price', '₹ per acre'),
  ],
  FLAT: [
    bhk(),
    num('built_up_area_sqft', 'Built-up area', 'sq ft', { required: true }),
    num('carpet_area_sqft', 'Carpet area', 'sq ft'),
    num('floor_no', 'Floor', undefined, { integer: true }),
    num('total_floors', 'Floors in the building', undefined, { integer: true }),
    facing,
    { key: 'parking', label: 'Car parking', kind: 'yesno' },
    num('expected_price', 'Asking price', '₹'),
  ],
  HOUSE: [
    bhk(),
    num('plot_area_sqyd', 'Plot area', 'sq yd', { required: true }),
    num('built_up_area_sqft', 'Built-up area', 'sq ft', { required: true }),
    num('floors', 'Floors (G+…)', undefined, { integer: true }),
    facing,
    num('road_width_ft', 'Road in front', 'ft'),
    num('expected_price', 'Asking price', '₹'),
  ],
  FLOOR: [
    bhk(),
    num('built_up_area_sqft', 'Built-up area', 'sq ft', { required: true }),
    num('floor_no', 'Floor', undefined, { integer: true }),
    facing,
    num('expected_price', 'Asking price', '₹'),
  ],
  COMMERCIAL: [
    num('built_up_area_sqft', 'Built-up area', 'sq ft', { required: true }),
    num('carpet_area_sqft', 'Carpet area', 'sq ft'),
    num('floor_no', 'Floor', undefined, { integer: true }),
    num('frontage_ft', 'Frontage', 'ft'),
    facing,
    num('expected_price', 'Asking price', '₹'),
  ],
};

export type ListingProjectGroup = 'LAYOUT' | 'FLATS' | 'HOUSES' | 'FARM' | 'COMMERCIAL' | 'OTHER';

export const listingProjectGroup = (projectType: string): ListingProjectGroup => {
  if (projectType === 'PLOTTED' || projectType === 'RESIDENTIAL_PLOTS') return 'LAYOUT';
  if (projectType === 'APARTMENT') return 'FLATS';
  if (['VILLA', 'INDEPENDENT_HOUSE', 'ROW_HOUSE', 'GATED_COMMUNITY'].includes(projectType))
    return 'HOUSES';
  if (projectType === 'AGRICULTURAL_LAND' || projectType === 'FARM_HOUSE') return 'FARM';
  if (projectType === 'COMMERCIAL_SHOP' || projectType === 'COMMERCIAL_OFFICE') return 'COMMERCIAL';
  return 'OTHER';
};

/** The details asked for a project, by its type. */
export const LISTING_PROJECT_FIELDS: Record<ListingProjectGroup, ListingField[]> = {
  LAYOUT: [
    num('total_land_acres', 'Total land', 'acres', { required: true }),
    num('total_units', 'Number of plots', undefined, { integer: true, required: true }),
    num('unit_size_min', 'Smallest plot', 'sq yd'),
    num('unit_size_max', 'Largest plot', 'sq yd'),
    { key: 'approval', label: 'Approval', kind: 'text', placeholder: 'DTCP, HMDA, RERA…' },
    num('price_per_sqyd', 'Price from', '₹ per sq yd'),
  ],
  FLATS: [
    num('total_land_acres', 'Total land', 'acres'),
    num('towers', 'Towers / blocks', undefined, { integer: true }),
    num('floors', 'Floors', undefined, { integer: true }),
    num('total_units', 'Number of flats', undefined, { integer: true, required: true }),
    { key: 'bhk_types', label: 'BHK types', kind: 'text', placeholder: '2 BHK, 3 BHK' },
    num('unit_size_min', 'Smallest flat', 'sq ft'),
    num('unit_size_max', 'Largest flat', 'sq ft'),
    num('price_per_sqft', 'Price from', '₹ per sq ft'),
  ],
  HOUSES: [
    num('total_land_acres', 'Total land', 'acres', { required: true }),
    num('total_units', 'Number of units', undefined, { integer: true, required: true }),
    num('unit_size_min', 'Smallest plot', 'sq yd'),
    num('unit_size_max', 'Largest plot', 'sq yd'),
    num('built_up_min', 'Built-up from', 'sq ft'),
    num('built_up_max', 'Built-up to', 'sq ft'),
    { key: 'bhk_types', label: 'BHK types', kind: 'text', placeholder: '3 BHK, 4 BHK' },
  ],
  FARM: [
    num('total_land_acres', 'Total land', 'acres', { required: true }),
    num('total_units', 'Number of plots', undefined, { integer: true }),
    num('unit_size_min', 'Smallest plot', 'guntas'),
    num('unit_size_max', 'Largest plot', 'guntas'),
    num('price_per_acre', 'Price from', '₹ per acre'),
  ],
  COMMERCIAL: [
    num('floors', 'Floors', undefined, { integer: true }),
    num('total_units', 'Number of units', undefined, { integer: true, required: true }),
    num('unit_size_min', 'Smallest unit', 'sq ft'),
    num('unit_size_max', 'Largest unit', 'sq ft'),
    num('price_per_sqft', 'Price from', '₹ per sq ft'),
  ],
  OTHER: [
    num('total_land_acres', 'Total land', 'acres'),
    num('total_units', 'Number of units', undefined, { integer: true }),
  ],
};

/**
 * Asked in every new listing, by a PM and by a channel partner alike (owner, 2026-11-24): what the customer pays
 * and when, and whether paying early earns a discount. Internal only: for our team and partners, never the public
 * website. All optional; amounts are numbers, the "when" and discount boxes are plain words.
 */
export const LISTING_PAYMENT_FIELDS: ListingField[] = [
  num('pay_booking_amount', 'Booking amount', '₹'),
  {
    key: 'pay_booking_when',
    label: 'Booking amount is paid',
    kind: 'text',
    placeholder: 'At booking',
  },
  num('pay_allotment_amount', 'Allotment amount', '₹'),
  {
    key: 'pay_allotment_when',
    label: 'Allotment amount is paid',
    kind: 'text',
    placeholder: 'Within 30 days of booking',
  },
  num('pay_final_amount', 'Final payment', '₹'),
  {
    key: 'pay_final_when',
    label: 'Final payment is paid',
    kind: 'text',
    placeholder: 'At registration',
  },
  {
    key: 'pay_discount',
    label: 'Discount for paying on time',
    kind: 'text',
    placeholder: '2% off if paid in full within 15 days',
  },
];

/** Projects only: can the buyer get a bank loan? */
export const LISTING_LOAN_FIELD: ListingField = {
  key: 'bank_loan_available',
  label: 'Bank loan available',
  kind: 'yesno',
};

export const listingFieldsFor = (type: 'PROPERTY' | 'PROJECT', kindValue: string) =>
  type === 'PROPERTY'
    ? [...LISTING_PROPERTY_FIELDS[listingPropertyGroup(kindValue)], ...LISTING_PAYMENT_FIELDS]
    : [
        ...LISTING_PROJECT_FIELDS[listingProjectGroup(kindValue)],
        LISTING_LOAN_FIELD,
        ...LISTING_PAYMENT_FIELDS,
      ];

/**
 * Checks the per-type details. Returns a list of problems (empty when fine)
 * and the cleaned values: numbers as numbers, yes/no as booleans, empty out.
 */
export function checkListingDetails(
  type: 'PROPERTY' | 'PROJECT',
  kindValue: string,
  input: Record<string, unknown>,
): { problems: string[]; values: Record<string, string | number | boolean> } {
  const problems: string[] = [];
  const values: Record<string, string | number | boolean> = {};
  for (const f of listingFieldsFor(type, kindValue)) {
    const raw = input[f.key];
    const empty = raw === undefined || raw === null || raw === '';
    if (empty) {
      if (f.required) problems.push(`${f.label} is required`);
      continue;
    }
    if (f.kind === 'number') {
      const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/,/g, ''));
      if (!Number.isFinite(n) || n < 0 || (n === 0 && f.required)) {
        problems.push(`${f.label} must be a number`);
      } else if (f.integer && !Number.isInteger(n)) {
        problems.push(`${f.label} must be a whole number`);
      } else if (n > 1e12) {
        problems.push(`${f.label} is too large`);
      } else values[f.key] = n;
    } else if (f.kind === 'yesno') {
      values[f.key] = raw === true || raw === 'true' || raw === 'yes';
    } else if (f.kind === 'select') {
      const v = String(raw);
      if (!f.options?.some((o) => o.value === v)) problems.push(`Pick a ${f.label.toLowerCase()}`);
      else values[f.key] = v;
    } else {
      const v = String(raw).trim().slice(0, 255);
      if (v) values[f.key] = v;
    }
  }
  // Farm land: acres or guntas, at least one.
  if (type === 'PROPERTY' && listingPropertyGroup(kindValue) === 'FARM') {
    if (!values.land_acres && !values.land_guntas)
      problems.push('Land in acres or guntas is required');
  }
  return { problems, values };
}

/** Area in sq ft for the property (the CRM's common unit), from the per-type details. */
export function listingAreaSqft(category: string, d: Record<string, unknown>): number | null {
  const n = (k: string) => (typeof d[k] === 'number' ? (d[k] as number) : 0);
  const g = listingPropertyGroup(category);
  let sqft = 0;
  if (g === 'PLOT') sqft = n('plot_area_sqyd') * 9;
  else if (g === 'FARM') sqft = n('land_acres') * 43560 + n('land_guntas') * 1089;
  else if (g === 'HOUSE') sqft = n('built_up_area_sqft') || n('plot_area_sqyd') * 9;
  else sqft = n('built_up_area_sqft') || n('carpet_area_sqft');
  return sqft > 0 ? Math.round(sqft * 100) / 100 : null;
}
