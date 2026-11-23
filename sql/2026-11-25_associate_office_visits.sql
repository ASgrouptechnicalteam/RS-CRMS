-- Office visits: an associate coming to our office to meet someone. One new table, nothing existing changes.
-- Safe to run twice. Live database: u988844918_CRM_API. Test database: u988844918_RSCRM (change the USE line).
SET NAMES utf8mb4;
USE `u988844918_CRM_API`;

CREATE TABLE IF NOT EXISTS `AssociateOfficeVisit` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `company_id` INT NOT NULL,
  `associate_id` INT NOT NULL,
  `scheduled_at` DATETIME(3) NOT NULL,
  `purpose` VARCHAR(20) NOT NULL DEFAULT 'OTHER',
  `met_by_id` INT NULL,
  `status` VARCHAR(12) NOT NULL DEFAULT 'PLANNED',
  `arrived_at` DATETIME(3) NULL,
  `done_at` DATETIME(3) NULL,
  `notes` VARCHAR(1000) NULL,
  `created_by_id` INT NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `AssociateOfficeVisit_company_id_scheduled_at_idx` (`company_id`, `scheduled_at`),
  KEY `AssociateOfficeVisit_associate_id_scheduled_at_idx` (`associate_id`, `scheduled_at`),
  KEY `AssociateOfficeVisit_met_by_id_scheduled_at_idx` (`met_by_id`, `scheduled_at`),
  CONSTRAINT `AssociateOfficeVisit_associate_id_fkey` FOREIGN KEY (`associate_id`) REFERENCES `Associate` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
