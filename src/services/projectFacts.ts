/**
 * The main facts of a project (2026-11-25): who approved it (from the approvals typed on the project) and the
 * details typed in by hand by the assigned PM, MD, Admin or Technical Manager: plots/flats, availability, sizes,
 * BHK types, starting price. Nothing is counted from units: the team does not keep units up to date.
 */
/** Plots and commercial space have no BHK. */
export const PROJECT_TYPES_WITHOUT_BHK = [
  'PLOTTED',
  'RESIDENTIAL_PLOTS',
  'AGRICULTURAL_LAND',
  'COMMERCIAL_SHOP',
  'COMMERCIAL_OFFICE',
  'COMMERCIAL',
];
export const hasBhk = (projectType: unknown) =>
  !PROJECT_TYPES_WITHOUT_BHK.includes(String(projectType ?? ''));

export interface ProjectFactsInput {
  id: number;
  project_type?: string | null;
  approval_authorities?: unknown;
  approval_authority?: string | null;
  rera_status?: string | null;
  rera_number?: string | null;
  key_details?: unknown;
}

export interface ProjectFacts {
  /** The approvals as short names, for the "approved by" stamps: DTCP, HMDA, RERA ... */
  approved_by: string[];
  units_total: number | null;
  units_available: number | null;
  /** Plot or flat sizes exactly as typed, e.g. "150, 200, 267 sq yd". */
  sizes: string | null;
  /** Each BHK type of the project, as typed (counts are optional). */
  bhk_types: { bhk: string; total: number | null; available: number | null }[];
  price_from: number | null;
  price_to: number | null;
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : v == null || v === '' ? NaN : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

const detailsOf = (raw: unknown): Record<string, any> => {
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

/** "RERA", "DTCP"... from the approvals typed on the project, without repeats and in a steady order. */
export const approvedByOf = (x: ProjectFactsInput): string[] => {
  const out: string[] = [];
  const add = (v: unknown) => {
    const s = String(v ?? '')
      .trim()
      .toUpperCase();
    if (s && s !== 'NOT_APPLICABLE' && !out.includes(s)) out.push(s);
  };
  const list = Array.isArray(x.approval_authorities)
    ? x.approval_authorities
    : typeof x.approval_authorities === 'string'
      ? (() => {
          try {
            const v = JSON.parse(x.approval_authorities as string);
            return Array.isArray(v) ? v : [];
          } catch {
            return [];
          }
        })()
      : [];
  for (const a of list) add(a);
  add(x.approval_authority);
  if (x.rera_status === 'APPROVED' || (x.rera_number && x.rera_number.trim())) add('RERA');
  return out;
};

const bhkOrder = (a: string, b: string) => {
  const n = (s: string) => parseFloat(s.replace(/[^0-9.]/g, '')) || 0;
  return n(a) - n(b) || a.localeCompare(b);
};

/** The facts of each project, from the project rows alone (no query). */
export function projectFactsFor(projects: ProjectFactsInput[]): Map<number, ProjectFacts> {
  const result = new Map<number, ProjectFacts>();
  for (const x of projects) {
    const d = detailsOf(x.key_details);
    const bhk = hasBhk(x.project_type) && Array.isArray(d.bhk_types) ? d.bhk_types : [];
    result.set(x.id, {
      approved_by: approvedByOf(x),
      units_total: num(d.units_total),
      units_available: num(d.units_available),
      sizes: typeof d.sizes === 'string' && d.sizes.trim() ? d.sizes.trim() : null,
      bhk_types: bhk
        .filter((b: any) => b && typeof b.bhk === 'string' && b.bhk.trim())
        .map((b: any) => ({ bhk: b.bhk.trim(), total: num(b.total), available: num(b.available) }))
        .sort((a: any, b: any) => bhkOrder(a.bhk, b.bhk)),
      price_from: num(d.price_from),
      price_to: num(d.price_to),
    });
  }
  return result;
}
