import { prisma } from '../lib/prisma';

/**
 * The main facts of a project, worked out from the project and its units (2026-11-25): who approved it, how many
 * plots/flats and how many are available, their sizes, the BHK types of an apartment project, and the starting
 * price. One calculation shared by the staff project page and cards and by the partner app, so every place shows
 * the same numbers. Nothing here is typed in by anyone.
 */
const p = prisma as any;

export interface ProjectFactsInput {
  id: number;
  approval_authorities?: unknown;
  approval_authority?: string | null;
  rera_status?: string | null;
  rera_number?: string | null;
}

export interface ProjectFacts {
  /** The approvals as short names, for the "approved by" stamps: DTCP, HMDA, RERA ... */
  approved_by: string[];
  units_total: number;
  units_available: number;
  /** Plot sizes in sq yd, smallest first (at most 24 different sizes are listed). */
  plot_sizes_sqyd: number[];
  /** Flat/house built-up sizes in sq ft, as a range. */
  flat_size_sqft: { min: number; max: number } | null;
  /** Each BHK type of the project with how many there are and how many are available. */
  bhk_types: { bhk: string; total: number; available: number }[];
  /** The lowest price among available plots/flats; null when none has a price. */
  price_from: number | null;
}

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

export async function projectFactsFor(
  projects: ProjectFactsInput[],
): Promise<Map<number, ProjectFacts>> {
  const ids = projects.map((x) => x.id);
  const result = new Map<number, ProjectFacts>();
  for (const x of projects) {
    result.set(x.id, {
      approved_by: approvedByOf(x),
      units_total: 0,
      units_available: 0,
      plot_sizes_sqyd: [],
      flat_size_sqft: null,
      bhk_types: [],
      price_from: null,
    });
  }
  if (!ids.length) return result;

  const [status, sizes, flats, bhks, prices] = await Promise.all([
    p.projectUnit.groupBy({
      by: ['project_id', 'sales_status'],
      where: { project_id: { in: ids } },
      _count: { _all: true },
    }),
    p.projectUnit.groupBy({
      by: ['project_id', 'area_sqyd'],
      where: { project_id: { in: ids }, area_sqyd: { gt: 0 } },
    }),
    p.projectUnit.groupBy({
      by: ['project_id'],
      where: { project_id: { in: ids }, bhk: { not: null }, area_sqft: { gt: 0 } },
      _min: { area_sqft: true },
      _max: { area_sqft: true },
    }),
    p.projectUnit.groupBy({
      by: ['project_id', 'bhk', 'sales_status'],
      where: { project_id: { in: ids }, bhk: { not: null } },
      _count: { _all: true },
    }),
    p.projectUnit.groupBy({
      by: ['project_id'],
      where: { project_id: { in: ids }, sales_status: 'AVAILABLE', final_price: { gt: 0 } },
      _min: { final_price: true },
    }),
  ]);

  for (const r of status) {
    const f = result.get(r.project_id)!;
    f.units_total += r._count._all;
    if (r.sales_status === 'AVAILABLE') f.units_available += r._count._all;
  }
  const sizeSets = new Map<number, Set<number>>();
  for (const r of sizes) {
    const set = sizeSets.get(r.project_id) || new Set<number>();
    set.add(Math.round(Number(r.area_sqyd) * 10) / 10);
    sizeSets.set(r.project_id, set);
  }
  for (const [id, set] of sizeSets) {
    result.get(id)!.plot_sizes_sqyd = [...set].sort((a, b) => a - b).slice(0, 24);
  }
  for (const r of flats) {
    const min = Number(r._min.area_sqft);
    const max = Number(r._max.area_sqft);
    if (min > 0) result.get(r.project_id)!.flat_size_sqft = { min, max };
  }
  const bhkMap = new Map<number, Map<string, { total: number; available: number }>>();
  for (const r of bhks) {
    const per = bhkMap.get(r.project_id) || new Map<string, { total: number; available: number }>();
    const row = per.get(r.bhk) || { total: 0, available: 0 };
    row.total += r._count._all;
    if (r.sales_status === 'AVAILABLE') row.available += r._count._all;
    per.set(r.bhk, row);
    bhkMap.set(r.project_id, per);
  }
  for (const [id, per] of bhkMap) {
    result.get(id)!.bhk_types = [...per.entries()]
      .sort((a, b) => bhkOrder(a[0], b[0]))
      .map(([bhk, v]) => ({ bhk, total: v.total, available: v.available }));
  }
  for (const r of prices) {
    const v = Number(r._min.final_price);
    if (v > 0) result.get(r.project_id)!.price_from = v;
  }
  return result;
}
