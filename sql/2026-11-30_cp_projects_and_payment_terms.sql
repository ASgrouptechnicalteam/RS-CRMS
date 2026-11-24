-- Channel partner projects, upload limit, PM members, and internal payment terms (2026-11-30).
-- Only ADDS: new nullable/defaulted columns and one new table. Nothing existing changes. Safe to run twice.
-- Run this BEFORE the new server is released. Live database: u988844918_CRM_API. Test database: u988844918_RSCRM
-- (change the USE line).
-- UNDO is not needed (extra empty columns are harmless); to remove, drop the added columns / table.
SET NAMES utf8mb4;
USE `u988844918_CRM_API`;

-- How many listings a partner may send (empty = the server default).
ALTER TABLE `Employee` ADD COLUMN IF NOT EXISTS `cp_project_limit` INT NULL;

-- A partner's team member can be a telecaller (default) or a PM, and can be one of our own employees.
ALTER TABLE `CpUser` ADD COLUMN IF NOT EXISTS `member_role` VARCHAR(12) NOT NULL DEFAULT 'TELECALLER';
ALTER TABLE `CpUser` ADD COLUMN IF NOT EXISTS `employee_id` INT NULL;
CREATE INDEX IF NOT EXISTS `CpUser_employee_id_idx` ON `CpUser` (`employee_id`);

-- Internal only: bank loan and payment terms of a project (never shown on the public website).
ALTER TABLE `Project` ADD COLUMN IF NOT EXISTS `bank_loan_available` TINYINT(1) NULL;
ALTER TABLE `Project` ADD COLUMN IF NOT EXISTS `payment_terms` LONGTEXT NULL;

-- Which projects are given to which partner.
CREATE TABLE IF NOT EXISTS `CpProjectAssignment` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `cp_id` INT NOT NULL,
  `project_id` INT NOT NULL,
  `assigned_by` INT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `CpProjectAssignment_cp_id_project_id_key` (`cp_id`, `project_id`),
  KEY `CpProjectAssignment_project_id_idx` (`project_id`)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
