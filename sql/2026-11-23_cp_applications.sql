-- Channel partner details form (public link shared with partners, shown in HR hub).
-- One new table; nothing existing is changed. Safe to run twice.
-- Run BEFORE pushing. Live database: u988844918_CRM_API. Test database: u988844918_RSCRM.
SET NAMES utf8mb4;
USE `u988844918_CRM_API`;

CREATE TABLE IF NOT EXISTS `CpApplication` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `company_id` INT NULL,
  `full_name` VARCHAR(120) NOT NULL,
  `phone` VARCHAR(20) NOT NULL,
  `email` VARCHAR(120) NOT NULL,
  `projects_handled` TEXT NOT NULL,
  `status` VARCHAR(12) NOT NULL DEFAULT 'NEW',
  `hr_note` VARCHAR(500) NULL,
  `submissions` INT NOT NULL DEFAULT 1,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `CpApplication_company_id_phone_key` (`company_id`, `phone`),
  KEY `CpApplication_status_created_at_idx` (`status`, `created_at`)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
