-- "Super admin" partner flag (2026-11-25). Two new columns on Employee (the flag, default 0, and when a partner group last signed in) (nobody is a super admin until the
-- MD/Admin turns it on). Only ADDS; safe to run twice. Run BEFORE the new server is released.
-- Live database: u988844918_CRM_API. Test database: u988844918_RSCRM (change the USE line).
SET NAMES utf8mb4;
USE `u988844918_CRM_API`;

ALTER TABLE `Employee` ADD COLUMN IF NOT EXISTS `cp_is_super` TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE `Employee` ADD COLUMN IF NOT EXISTS `cp_last_seen_at` DATETIME(3) NULL;
