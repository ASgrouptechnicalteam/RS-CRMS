-- Sales managers can start and finish the site visits they take (2026-11-27).
-- Safe to run again. Run in phpMyAdmin BEFORE the new server code. Adds one permission link only.
INSERT IGNORE INTO `Permission` (name, description) VALUES ('site_visits.complete', 'site_visits.complete');

INSERT IGNORE INTO `RolePermission` (role_id, permission_id)
SELECT r.id, p.id FROM `Role` r JOIN `Permission` p ON p.name = 'site_visits.complete'
WHERE r.name = 'Sales manager';

-- Sales managers sign out and in again to see the new buttons.
-- Check (read only): one row.
SELECT r.name AS role, p.name AS permission FROM `RolePermission` rp
JOIN `Role` r ON r.id = rp.role_id JOIN `Permission` p ON p.id = rp.permission_id
WHERE r.name = 'Sales manager' AND p.name = 'site_visits.complete';
