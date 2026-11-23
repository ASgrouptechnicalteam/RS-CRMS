-- Refer a company lead to a channel partner (separate inbox "Referred by RRH").
-- Two new tables and one optional column; nothing existing is changed. Safe to run twice.
-- Run BEFORE pushing. Run the statements one at a time in phpMyAdmin.
-- Live database: u988844918_CRM_API. Test database: u988844918_RSCRM (change the USE line).
SET NAMES utf8mb4;
USE `u988844918_CRM_API`;

CREATE TABLE IF NOT EXISTS `CpReferral` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `company_id` INT NOT NULL,
  `lead_id` INT NOT NULL,
  `cp_id` INT NOT NULL,
  `referred_by_id` INT NOT NULL,
  `brief` TEXT NULL,
  `stage_at_referral` VARCHAR(30) NOT NULL,
  `status` VARCHAR(12) NOT NULL DEFAULT 'OFFERED',
  `partner_stage` VARCHAR(20) NULL,
  `assigned_to_id` INT NULL,
  `open_lead_id` INT NULL,
  `offered_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `accepted_at` DATETIME(3) NULL,
  `last_activity_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `closed_at` DATETIME(3) NULL,
  `closed_reason` VARCHAR(300) NULL,
  `stale_notified_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `CpReferral_open_lead_id_key` (`open_lead_id`),
  KEY `CpReferral_cp_id_status_idx` (`cp_id`, `status`),
  KEY `CpReferral_lead_id_idx` (`lead_id`),
  KEY `CpReferral_company_id_status_idx` (`company_id`, `status`)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `CpReferralActivity` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `referral_id` INT NOT NULL,
  `cp_id` INT NOT NULL,
  `actor_user_id` INT NULL,
  `actor_name` VARCHAR(120) NOT NULL,
  `kind` VARCHAR(12) NOT NULL,
  `outcome` VARCHAR(30) NULL,
  `notes` TEXT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `CpReferralActivity_referral_id_created_at_idx` (`referral_id`, `created_at`)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE `Lead`
  ADD COLUMN IF NOT EXISTS `referred_to_cp_id` INT NULL;

ALTER TABLE `Lead`
  ADD INDEX IF NOT EXISTS `Lead_referred_to_cp_id_idx` (`referred_to_cp_id`);
