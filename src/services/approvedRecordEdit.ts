import { Request } from 'express';
import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';
import { Roles } from '../shared';

/**
 * Item 3 / owner decision 7 (2026-11-15): the Digital Marketing Head stays
 * able to change approved records, but every change to an approved project
 * (VERIFIED) or a LIVE property by anyone other than the MD or Admin is
 * written as its own audit event, APPROVED_RECORD_EDIT, so the MD can see it.
 */
export const APPROVED_RECORD_EDIT = 'APPROVED_RECORD_EDIT';

/** LIVE and every state after it counts as approved. */
const APPROVED_PROPERTY = ['LIVE', 'LOCKED', 'BOOKED', 'SOLD'];

export const isApproved = (entity: 'PROJECT' | 'PROPERTY', status: string | null | undefined) =>
  entity === 'PROJECT' ? status === 'VERIFIED' : APPROVED_PROPERTY.includes(status || '');

/** Never throws: a failed audit write must not fail the change itself. */
export async function recordApprovedEdit(
  req: Request & { user?: { employeeId: number; roles: string[]; companyId: number } },
  entity: 'PROJECT' | 'PROPERTY',
  entityId: number,
  status: string | null | undefined,
) {
  const user = req.user;
  if (!user || !isApproved(entity, status)) return;
  if (user.roles.includes(Roles.MD) || user.roles.includes(Roles.ADMIN)) return;
  try {
    await prisma.auditEvent.create({
      data: {
        actor_id: user.employeeId,
        action: APPROVED_RECORD_EDIT,
        entity_type: entity,
        entity_id: entityId,
        company_id: user.companyId,
        new_value: JSON.stringify({
          method: req.method,
          path: (req.originalUrl || req.url || '').split('?')[0],
          status,
          roles: user.roles,
        }),
        reason: `Changed an approved ${entity === 'PROJECT' ? 'project' : 'property'}`,
      },
    });
  } catch (err) {
    logger.error({ err }, '[ApprovedRecordEdit] audit write failed');
  }
}
