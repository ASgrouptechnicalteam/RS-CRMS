-- Forward a lead to an associate (their "From RRH" list in the associate app).
-- One new table and one new column on Lead. Safe to run twice. Run each statement on its own in phpMyAdmin.
-- Live database: u988844918_CRM_API. Test database: u988844918_RSCRM (change the USE line).
SET NAMES utf8mb4;
USE `u988844918_CRM_API`;

ALTER TABLE `Lead` ADD COLUMN IF NOT EXISTS `referred_to_associate_id` INT NULL;
CREATE INDEX IF NOT EXISTS `Lead_referred_to_associate_id_idx` ON `Lead` (`referred_to_associate_id`);

CREATE TABLE IF NOT EXISTS `AssociateReferral` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `company_id` INT NOT NULL,
  `lead_id` INT NOT NULL,
  `associate_id` INT NOT NULL,
  `referred_by_id` INT NOT NULL,
  `brief` TEXT NULL,
  `stage_at_referral` VARCHAR(30) NOT NULL,
  `status` VARCHAR(12) NOT NULL DEFAULT 'OFFERED',
  `associate_stage` VARCHAR(20) NULL,
  `associate_note` VARCHAR(500) NULL,
  `open_lead_id` INT NULL,
  `offered_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `accepted_at` DATETIME(3) NULL,
  `last_activity_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `closed_at` DATETIME(3) NULL,
  `closed_reason` VARCHAR(300) NULL,
  `stale_notified_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `AssociateReferral_open_lead_id_key` (`open_lead_id`),
  KEY `AssociateReferral_associate_id_status_idx` (`associate_id`, `status`),
  KEY `AssociateReferral_lead_id_idx` (`lead_id`),
  KEY `AssociateReferral_company_id_status_idx` (`company_id`, `status`)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
