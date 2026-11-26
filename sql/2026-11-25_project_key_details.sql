-- A project's main details typed in by hand (2026-11-25): plots/flats, availability, sizes, BHK types, starting price.
-- One new nullable column on Project. Only ADDS; safe to run twice. Run BEFORE the new server is released.
-- Live database: u988844918_CRM_API. Test database: u988844918_RSCRM (change the USE line).
SET NAMES utf8mb4;
USE `u988844918_CRM_API`;

ALTER TABLE `Project` ADD COLUMN IF NOT EXISTS `key_details` LONGTEXT NULL;
