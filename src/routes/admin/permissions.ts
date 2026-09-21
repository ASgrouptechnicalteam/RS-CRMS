import { logger } from '../../utils/logger';
import { Router, Response } from 'express';
import { prisma } from '../../lib/prisma';
import { authenticateToken, AuthenticatedRequest, requireRole } from '../../middleware/auth';
import { Roles, Permissions, RolePermissionsMatrix } from '../../shared';
import { validateRequestBody } from '../../middleware/validate';
import { z } from 'zod';
import { setRolePermissionOverrideCacheDirty } from '../../authz/dbPermissions';
import { notifyEmployee } from '../../utils/notifyEmployee';

const router = Router();
const p = prisma;

const UpdateRolePermissionsSchema = z.object({
  granted: z.array(z.string()).optional(),
  denied: z.array(z.string()).optional(),
});

/**
 * Dynamic Permissions Management — Admin / MD only
 * These endpoints manage the RolePermission join table.
 *
 * Propagation timing, precisely: a newly GRANTED permission is checked via
 * checkDbPermission()'s cache (30s TTL) and can apply within that window
 * without anyone re-logging in. A DENIED/removed permission is NOT caught by
 * that cache (dbPermissions.ts's checkDbPermission only ever adds, never
 * subtracts — see its own doc comment), so it only takes effect once each
 * affected employee's JWT is rebuilt from the DB, which normally happens
 * silently within 24h (the access-token lifetime) via /auth/refresh. To make
 * every change — grant or deny — apply immediately instead of within that
 * window, every write here also bumps token_version and revokes active
 * sessions for every employee holding the role, exactly like changing an
 * individual employee's role assignment already does
 * (routes/employees/admin-actions.ts PUT /:id/roles) — this file just applies
 * the same pattern at the role level.
 */

/**
 * Deletes all RolePermission rows for a role and recreates them from
 * RolePermissionsMatrix[role.name] — the actual "reset to default" a role's
 * permissions should mean. (The matrix is also what apps/api/prisma/seed.ts
 * and fix-pm-permissions.ts treat as canonical.) Returns the permission
 * names actually restored (a matrix entry with no matching Permission row
 * yet is silently skipped, same as before).
 */
async function resetRoleToDefaults(tx: any, role: { id: number; name: string }): Promise<string[]> {
  await tx.rolePermission.deleteMany({ where: { role_id: role.id } });

  const defaults = RolePermissionsMatrix[role.name as keyof typeof RolePermissionsMatrix] || [];
  if (defaults.length === 0) return [];

  const permRecords = await tx.permission.findMany({ where: { name: { in: defaults } } });
  if (permRecords.length === 0) return [];

  await tx.rolePermission.createMany({
    data: permRecords.map((perm: { id: number }) => ({ role_id: role.id, permission_id: perm.id })),
    skipDuplicates: true,
  });
  return permRecords.map((perm: { name: string }) => perm.name);
}

/**
 * Replaces a role's entire RolePermission set with an exact permission-name
 * list — the shared primitive Undo/Redo restore onto (a saved before/after
 * snapshot), as opposed to resetRoleToDefaults which always targets the code
 * matrix specifically.
 */
async function applyPermissionState(
  tx: any,
  role: { id: number },
  permissionNames: string[],
): Promise<void> {
  await tx.rolePermission.deleteMany({ where: { role_id: role.id } });
  if (permissionNames.length === 0) return;

  const permRecords = await tx.permission.findMany({ where: { name: { in: permissionNames } } });
  if (permRecords.length === 0) return;

  await tx.rolePermission.createMany({
    data: permRecords.map((perm: { id: number }) => ({ role_id: role.id, permission_id: perm.id })),
    skipDuplicates: true,
  });
}

/**
 * Records one Undo/Redo-able step for a role: truncates any history past the
 * role's current position (the standard undo-stack rule — a fresh change
 * discards whatever redo branch was sitting ahead of it), appends the new
 * before/after snapshot, and advances the role's position to point at it.
 * Must run inside the same transaction as the permission write itself so the
 * two can never drift apart.
 */
async function recordHistory(
  tx: any,
  role: { id: number },
  action: 'UPDATE' | 'RESET',
  beforeNames: string[],
  afterNames: string[],
  actorId: number,
): Promise<void> {
  const current = await tx.role.findUnique({
    where: { id: role.id },
    select: { permission_history_position: true },
  });
  const position = current?.permission_history_position ?? 0;

  await tx.rolePermissionHistory.deleteMany({ where: { role_id: role.id, seq: { gt: position } } });

  const newSeq = position + 1;
  await tx.rolePermissionHistory.create({
    data: {
      role_id: role.id,
      seq: newSeq,
      action,
      before: JSON.stringify(beforeNames),
      after: JSON.stringify(afterNames),
      actor_id: actorId,
    },
  });
  await tx.role.update({ where: { id: role.id }, data: { permission_history_position: newSeq } });
}

/** canUndo/canRedo for a role, given its current position and history depth. */
async function getHistoryStatus(
  roleId: number,
  position: number,
): Promise<{ canUndo: boolean; canRedo: boolean }> {
  const [hasEarlier, hasLater] = await Promise.all([
    position > 0,
    p.rolePermissionHistory.findFirst({ where: { role_id: roleId, seq: position + 1 } }),
  ]);
  return { canUndo: hasEarlier, canRedo: !!hasLater };
}

/**
 * Forces every employee currently holding this role to re-authenticate on
 * their next request, so a permission change (grant or deny) is enforced
 * immediately rather than waiting for their access token to naturally expire.
 * Returns the affected employee IDs (for the caller to notify).
 */
async function invalidateSessionsForRole(tx: any, roleId: number): Promise<number[]> {
  const memberships = await tx.employeeRole.findMany({
    where: { role_id: roleId },
    select: { employee_id: true },
  });
  const employeeIds = memberships.map((m: { employee_id: number }) => m.employee_id);
  if (employeeIds.length === 0) return employeeIds;

  await tx.employee.updateMany({
    where: { id: { in: employeeIds } },
    data: { token_version: { increment: 1 } },
  });
  await tx.authSession.updateMany({
    where: { employee_id: { in: employeeIds }, revoked: false },
    data: { revoked: true, revocation_reason: 'ROLE_PERMISSIONS_CHANGED' },
  });
  return employeeIds;
}

// GET /api/v1/admin/permissions — Get all roles with their effective permissions
router.get(
  '/permissions',
  authenticateToken,
  requireRole([Roles.MD, Roles.ADMIN]),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const roles = await p.role.findMany({
        include: {
          permissions: {
            include: {
              permission: true,
            },
          },
        },
        orderBy: { name: 'asc' },
      });

      // Also fetch all known permission keys from the shared enum for the UI dropdowns
      const allPermissionKeys = Object.values(Permissions);

      const rolePerms = await Promise.all(
        roles.map(async (r: any) => ({
          id: r.id,
          name: r.name,
          is_system: r.is_system,
          permissions: r.permissions.map((rp: any) => rp.permission.name),
          ...(await getHistoryStatus(r.id, r.permission_history_position)),
        })),
      );

      return res.status(200).json({
        roles: rolePerms,
        allPermissionKeys,
      });
    } catch (error) {
      logger.error('[Admin] Permissions fetch failed:', error);
      return res.status(500).json({ error: 'Failed to fetch role permissions' });
    }
  },
);

// GET /api/v1/admin/permissions/:roleName — Get permissions for a specific role
router.get(
  '/permissions/:roleName',
  authenticateToken,
  requireRole([Roles.MD, Roles.ADMIN]),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const role = await p.role.findUnique({
        where: { name: req.params.roleName },
        include: {
          permissions: {
            include: {
              permission: true,
            },
          },
        },
      });

      if (!role) {
        return res.status(404).json({ error: 'Role not found' });
      }

      return res.status(200).json({
        id: role.id,
        name: role.name,
        is_system: role.is_system,
        permissions: role.permissions.map((rp: any) => rp.permission.name),
        ...(await getHistoryStatus(role.id, role.permission_history_position)),
      });
    } catch (error) {
      logger.error('[Admin] Single role permissions fetch failed:', error);
      return res.status(500).json({ error: 'Failed to fetch role permissions' });
    }
  },
);

// PATCH /api/v1/admin/permissions/:roleName — Update permissions for a role
router.patch(
  '/permissions/:roleName',
  authenticateToken,
  requireRole([Roles.MD, Roles.ADMIN]),
  validateRequestBody(UpdateRolePermissionsSchema),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const roleName = req.params.roleName;
      const { granted, denied } = req.body;

      const role = await p.role.findUnique({
        where: { name: roleName },
      });

      if (!role) {
        return res.status(404).json({ error: 'Role not found' });
      }

      const actions: string[] = [];

      // Add granted permissions (if not already present)
      const existingPermRecords = await p.rolePermission.findMany({
        where: { role_id: role.id },
        select: { permission: { select: { name: true } } },
      });
      const existingPerms = new Set(existingPermRecords.map((rp: any) => rp.permission.name));

      const toAdd = granted?.filter((p: string) => !existingPerms.has(p)) ?? [];
      const toRemove = denied?.filter((p: string) => existingPerms.has(p)) ?? [];

      // toAdd/toRemove are already filtered against the real DB state above,
      // so a request whose diff resolves to nothing real (e.g. the frontend
      // asking to deny a permission that was never actually granted) must
      // not write an audit entry or touch anyone's session — there is
      // nothing to log or enforce.
      const hasRealChange = toAdd.length > 0 || toRemove.length > 0;
      const afterNames = [...existingPerms].filter((p) => !toRemove.includes(p)).concat(toAdd);

      // Look up permission records by name
      const permRecords = await p.permission.findMany({
        where: { name: { in: [...toAdd, ...toRemove] } },
      });
      const permMap = new Map(permRecords.map((p: any) => [p.name, p.id]));

      await p.$transaction(async (tx: any) => {
        for (const permName of toAdd) {
          const permId = permMap.get(permName);
          if (permId) {
            await tx.rolePermission.create({
              data: {
                role_id: role.id,
                permission_id: permId,
              },
            });
            actions.push(`GRANT ${permName}`);
          }
        }

        for (const permName of toRemove) {
          const permId = permMap.get(permName);
          if (permId) {
            await tx.rolePermission.delete({
              where: {
                role_id_permission_id: {
                  role_id: role.id,
                  permission_id: permId,
                },
              },
            });
            actions.push(`DENY ${permName}`);
          }
        }

        if (hasRealChange) {
          await recordHistory(
            tx,
            role,
            'UPDATE',
            [...existingPerms],
            afterNames,
            req.user!.employeeId,
          );
        }
      });

      if (hasRealChange) {
        await p.auditEvent.create({
          data: {
            actor_id: req.user!.employeeId,
            action: 'UPDATE_ROLE_PERMISSIONS',
            entity_type: 'ROLE',
            entity_id: role.id,
            old_value: JSON.stringify({ permissions: [...existingPerms] }),
            new_value: JSON.stringify({ granted: toAdd, denied: toRemove, actions }),
          },
        });

        // Invalidate authz cache so grants take effect within its 30s TTL
        setRolePermissionOverrideCacheDirty();
      }

      // A grant already propagates within the cache's 30s TTL above — only a
      // DENY needs the forced re-auth, since removing a RolePermission row
      // does nothing to an employee's already-issued JWT until it refreshes
      // (see this file's header comment). Skip the disruption entirely for a
      // grant-only change.
      const affectedEmployeeIds =
        toRemove.length > 0
          ? await p.$transaction((tx: any) => invalidateSessionsForRole(tx, role.id))
          : [];
      if (affectedEmployeeIds.length > 0) {
        await notifyEmployee(affectedEmployeeIds, {
          type: 'ROLE_PERMISSIONS_CHANGED',
          title: '🔐 Your Access Was Updated',
          message: `Permissions for your role (${roleName}) were changed by an administrator. Please log in again to apply the update.`,
        });
      }

      // Fetch updated permissions
      const updated = await p.role.findUnique({
        where: { id: role.id },
        include: {
          permissions: {
            include: {
              permission: true,
            },
          },
        },
      });

      return res.status(200).json({
        message: `Permissions updated for role ${roleName}`,
        role: {
          id: updated!.id,
          name: updated!.name,
          permissions: updated!.permissions.map((rp: any) => rp.permission.name),
          ...(await getHistoryStatus(updated!.id, updated!.permission_history_position)),
        },
      });
    } catch (error: any) {
      logger.error('[Admin] Role permissions update failed:', error);
      return res
        .status(500)
        .json({ error: 'Failed to update role permissions', detail: error?.message });
    }
  },
);

// DELETE /api/v1/admin/permissions/:roleName/reset — Reset a role's permissions to defaults
router.delete(
  '/permissions/:roleName/reset',
  authenticateToken,
  requireRole([Roles.MD, Roles.ADMIN]),
  validateRequestBody(z.object({})),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const roleName = req.params.roleName;
      const role = await p.role.findUnique({
        where: { name: roleName },
      });

      if (!role) {
        return res.status(404).json({ error: 'Role not found' });
      }

      const previousPermRecords = await p.rolePermission.findMany({
        where: { role_id: role.id },
        select: { permission: { select: { name: true } } },
      });
      const previousPerms = previousPermRecords.map((rp: any) => rp.permission.name);

      const restoredNames = await p.$transaction(async (tx: any) => {
        const names = await resetRoleToDefaults(tx, role);
        await recordHistory(tx, role, 'RESET', previousPerms, names, req.user!.employeeId);
        return names;
      });
      const restoredCount = restoredNames.length;

      await p.auditEvent.create({
        data: {
          actor_id: req.user!.employeeId,
          action: 'RESET_ROLE_PERMISSIONS',
          entity_type: 'ROLE',
          entity_id: role.id,
          old_value: JSON.stringify({ permissions: previousPerms }),
          new_value: `Reset to ${restoredCount} default permission(s) from RolePermissionsMatrix`,
        },
      });

      // Invalidate authz cache so the reset is reflected within its 30s TTL
      setRolePermissionOverrideCacheDirty();

      // Force every employee holding this role to re-authenticate — otherwise
      // anyone the reset was meant to REVOKE access from keeps it via their
      // existing token for up to 24h (see this file's header comment).
      const affectedEmployeeIds = await p.$transaction((tx: any) =>
        invalidateSessionsForRole(tx, role.id),
      );
      if (affectedEmployeeIds.length > 0) {
        await notifyEmployee(affectedEmployeeIds, {
          type: 'ROLE_PERMISSIONS_CHANGED',
          title: '🔐 Your Access Was Updated',
          message: `Permissions for your role (${roleName}) were reset to defaults by an administrator. Please log in again to apply the update.`,
        });
      }

      const refreshed = await p.role.findUnique({ where: { id: role.id } });

      return res.status(200).json({
        message: `Permissions reset to defaults for role ${roleName}`,
        permissionsRestored: restoredCount,
        ...(await getHistoryStatus(role.id, refreshed!.permission_history_position)),
      });
    } catch (error) {
      logger.error('[Admin] Role permissions reset failed:', error);
      return res.status(500).json({ error: 'Failed to reset role permissions' });
    }
  },
);

// POST /api/v1/admin/permissions/:roleName/undo — Step this role's permissions
// back to the snapshot recorded before its most recent saved change (an
// UPDATE or a RESET, or a previous REDO — anything that advanced its
// position). A no-op with a 400 if there's nothing earlier to go back to.
router.post(
  '/permissions/:roleName/undo',
  authenticateToken,
  requireRole([Roles.MD, Roles.ADMIN]),
  validateRequestBody(z.object({})),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const role = await p.role.findUnique({ where: { name: req.params.roleName } });
      if (!role) {
        return res.status(404).json({ error: 'Role not found' });
      }
      if (role.permission_history_position <= 0) {
        return res.status(400).json({ error: 'Nothing to undo for this role' });
      }

      const step = await p.rolePermissionHistory.findUnique({
        where: {
          role_id_seq: { role_id: role.id, seq: role.permission_history_position },
        },
      });
      if (!step) {
        return res.status(400).json({ error: 'Nothing to undo for this role' });
      }
      const restoreTo: string[] = JSON.parse(step.before);

      await p.$transaction(async (tx: any) => {
        await applyPermissionState(tx, role, restoreTo);
        await tx.role.update({
          where: { id: role.id },
          data: { permission_history_position: role.permission_history_position - 1 },
        });
      });

      await p.auditEvent.create({
        data: {
          actor_id: req.user!.employeeId,
          action: 'UNDO_ROLE_PERMISSIONS',
          entity_type: 'ROLE',
          entity_id: role.id,
          old_value: step.after,
          new_value: step.before,
        },
      });

      setRolePermissionOverrideCacheDirty();
      const affectedEmployeeIds = await p.$transaction((tx: any) =>
        invalidateSessionsForRole(tx, role.id),
      );
      if (affectedEmployeeIds.length > 0) {
        await notifyEmployee(affectedEmployeeIds, {
          type: 'ROLE_PERMISSIONS_CHANGED',
          title: '🔐 Your Access Was Updated',
          message: `Permissions for your role (${req.params.roleName}) were reverted by an administrator (Undo). Please log in again to apply the update.`,
        });
      }

      return res.status(200).json({
        message: `Undid the last permission change for role ${req.params.roleName}`,
        role: {
          id: role.id,
          name: role.name,
          permissions: restoreTo,
          ...(await getHistoryStatus(role.id, role.permission_history_position - 1)),
        },
      });
    } catch (error) {
      logger.error('[Admin] Role permissions undo failed:', error);
      return res.status(500).json({ error: 'Failed to undo role permission change' });
    }
  },
);

// POST /api/v1/admin/permissions/:roleName/redo — Re-apply the change that
// was just Undone. A no-op with a 400 if there's nothing ahead to redo (this
// naturally becomes true again the moment a fresh UPDATE/RESET is saved,
// since that truncates the abandoned redo branch — see recordHistory).
router.post(
  '/permissions/:roleName/redo',
  authenticateToken,
  requireRole([Roles.MD, Roles.ADMIN]),
  validateRequestBody(z.object({})),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const role = await p.role.findUnique({ where: { name: req.params.roleName } });
      if (!role) {
        return res.status(404).json({ error: 'Role not found' });
      }

      const nextSeq = role.permission_history_position + 1;
      const step = await p.rolePermissionHistory.findUnique({
        where: { role_id_seq: { role_id: role.id, seq: nextSeq } },
      });
      if (!step) {
        return res.status(400).json({ error: 'Nothing to redo for this role' });
      }
      const restoreTo: string[] = JSON.parse(step.after);

      await p.$transaction(async (tx: any) => {
        await applyPermissionState(tx, role, restoreTo);
        await tx.role.update({
          where: { id: role.id },
          data: { permission_history_position: nextSeq },
        });
      });

      await p.auditEvent.create({
        data: {
          actor_id: req.user!.employeeId,
          action: 'REDO_ROLE_PERMISSIONS',
          entity_type: 'ROLE',
          entity_id: role.id,
          old_value: step.before,
          new_value: step.after,
        },
      });

      setRolePermissionOverrideCacheDirty();
      const affectedEmployeeIds = await p.$transaction((tx: any) =>
        invalidateSessionsForRole(tx, role.id),
      );
      if (affectedEmployeeIds.length > 0) {
        await notifyEmployee(affectedEmployeeIds, {
          type: 'ROLE_PERMISSIONS_CHANGED',
          title: '🔐 Your Access Was Updated',
          message: `Permissions for your role (${req.params.roleName}) were reapplied by an administrator (Redo). Please log in again to apply the update.`,
        });
      }

      return res.status(200).json({
        message: `Redid the last undone permission change for role ${req.params.roleName}`,
        role: {
          id: role.id,
          name: role.name,
          permissions: restoreTo,
          ...(await getHistoryStatus(role.id, nextSeq)),
        },
      });
    } catch (error) {
      logger.error('[Admin] Role permissions redo failed:', error);
      return res.status(500).json({ error: 'Failed to redo role permission change' });
    }
  },
);

// GET /api/v1/admin/permissions/matrix — Full role-permission matrix as a flat map
// Useful for a quick matrix-style UI
router.get(
  '/permissions-matrix',
  authenticateToken,
  requireRole([Roles.MD, Roles.ADMIN]),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const allPermissionKeys = Object.values(Permissions);
      const roles = await p.role.findMany({
        include: {
          permissions: {
            select: { permission: { select: { name: true } } },
          },
        },
        orderBy: { name: 'asc' },
      });

      const matrix: Record<string, Record<string, boolean>> = {};
      roles.forEach((role: any) => {
        const granted = new Set(role.permissions.map((rp: any) => rp.permission.name));
        matrix[role.name] = {};
        allPermissionKeys.forEach((key: any) => {
          matrix[role.name][key] = granted.has(key);
        });
      });

      return res.status(200).json({
        matrix,
        permissionKeys: allPermissionKeys,
        roleNames: roles.map((r: any) => r.name),
      });
    } catch (error) {
      logger.error('[Admin] Permissions matrix fetch failed:', error);
      return res.status(500).json({ error: 'Failed to fetch permissions matrix' });
    }
  },
);

export default router;
