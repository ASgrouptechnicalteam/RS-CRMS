import { prisma } from '../../lib/prisma';
import { Roles } from '../../shared';

/**
 * Role groups for rankings: people are only ranked against others doing the
 * same kind of work. The MD, Admin and Technical Manager are never ranked.
 */
export const ROLE_GROUPS = [
  {
    key: 'SALES',
    label: 'Sales',
    roles: [Roles.TELECALLER, Roles.AGENT, Roles.SALES_MANAGER] as string[],
  },
  { key: 'FIELD', label: 'Project managers', roles: [Roles.PROJECT_MANAGER] as string[] },
  { key: 'CHANNEL', label: 'Channel partners', roles: [Roles.CHANNEL_PARTNER_MANAGER] as string[] },
  {
    key: 'MARKETING',
    label: 'Marketing and leads',
    roles: [
      Roles.DIGITAL_LEAD_OPERATOR,
      Roles.DIGITAL_MARKETING_HEAD,
      Roles.DIGITAL_MARKETING_EXECUTIVE,
      Roles.MARKETING_DIRECTOR,
    ] as string[],
  },
  {
    key: 'OFFICE',
    label: 'Back office',
    roles: [
      Roles.HR_MANAGER,
      Roles.FINANCE,
      Roles.INVENTORY_EXECUTIVE,
      Roles.DATA_ENTRY_OPERATOR,
      Roles.STAFF,
    ] as string[],
  },
] as const;
export type GroupKey = (typeof ROLE_GROUPS)[number]['key'];

export const UNRANKED_ROLES: string[] = [Roles.MD, Roles.ADMIN, Roles.TECHNICAL_MANAGER];

/** The ranking group for someone's roles (the first that fits), or null when they are not ranked. */
export function groupOf(roles: string[]): GroupKey | null {
  if (roles.some((r) => UNRANKED_ROLES.includes(r))) return null;
  return ROLE_GROUPS.find((g) => g.roles.some((r) => roles.includes(r)))?.key ?? null;
}

export interface Person {
  id: number;
  full_name: string | null;
  employee_code: string;
  company_id: number;
  reporting_manager_id: number | null;
  roles: string[];
}

/**
 * Staff of these companies (no invisible technical accounts, nobody deleted).
 * A leaver still shows for a period they worked in.
 */
export async function staffOf(companyIds: number[], since?: Date): Promise<Person[]> {
  const rows = await prisma.employee.findMany({
    where: {
      company_id: { in: companyIds },
      deleted_at: null,
      roles: { none: { role: { is_invisible: true } } },
      OR: [{ status: 'ACTIVE' }, ...(since ? [{ last_working_day: { gte: since } }] : [])],
    },
    select: {
      id: true,
      full_name: true,
      employee_code: true,
      company_id: true,
      reporting_manager_id: true,
      roles: { select: { role: { select: { name: true } } } },
    },
    orderBy: { full_name: 'asc' },
  });
  return rows.map((r) => ({ ...r, roles: r.roles.map((x) => x.role.name) }));
}

/**
 * Standard competition ranking: equal keys share a rank (1, 1, 3). `key`
 * returns the numbers to sort by, most important first, higher is better.
 */
export function rankBy<T>(rows: T[], key: (r: T) => number[]): (T & { rank: number })[] {
  const sorted = [...rows].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return kb[i] - ka[i];
    return 0;
  });
  let rank = 0;
  let prev: number[] | null = null;
  return sorted.map((r, i) => {
    const k = key(r);
    if (!prev || k.some((v, j) => v !== prev![j])) rank = i + 1;
    prev = k;
    return { ...r, rank };
  });
}

export const nameOf = (p: { full_name: string | null; employee_code: string }) =>
  p.full_name || p.employee_code;
