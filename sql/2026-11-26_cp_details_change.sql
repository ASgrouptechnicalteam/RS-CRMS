-- Partners editing their own bank / PAN / Aadhaar details (2026-11-26): changes to saved values wait here until HR,
-- the MD or Admin confirms. One new table; nothing existing changes. Safe to run twice. Run BEFORE the new server.
-- Live database: u988844918_CRM_API. Test database: u988844918_RSCRM (change the USE line).
SET NAMES utf8mb4;
USE `u988844918_CRM_API`;

CREATE TABLE IF NOT EXISTS `CpDetailsChange` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `cp_id` INT NOT NULL,
  `company_id` INT NOT NULL,
  `fields` LONGTEXT NOT NULL,
  `summary` VARCHAR(500) NOT NULL,
  `status` VARCHAR(12) NOT NULL DEFAULT 'PENDING',
  `decided_by` INT NULL,
  `decided_at` DATETIME(3) NULL,
  `note` VARCHAR(300) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `CpDetailsChange_cp_id_status_idx` (`cp_id`, `status`),
  KEY `CpDetailsChange_company_id_status_idx` (`company_id`, `status`)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
