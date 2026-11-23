-- Channel partner registration form v2: the paper form's fields (identity, address, bank, PAN, Aadhaar, terms)
-- and an auto partner number (RRH-CP-0001, made by the server). Only adds columns; safe to run twice.
-- Aadhaar, PAN and bank account are stored encrypted by the API. Run BEFORE pushing.
-- Live database: u988844918_CRM_API. Test database: u988844918_RSCRM. Change the USE line for test.
SET NAMES utf8mb4;
USE `u988844918_CRM_API`;

ALTER TABLE `CpApplication`
  ADD COLUMN IF NOT EXISTS `partner_no` VARCHAR(20) NULL,
  ADD COLUMN IF NOT EXISTS `occupation` VARCHAR(80) NULL,
  ADD COLUMN IF NOT EXISTS `age` INT NULL,
  ADD COLUMN IF NOT EXISTS `father_spouse_name` VARCHAR(120) NULL,
  ADD COLUMN IF NOT EXISTS `address` TEXT NULL,
  ADD COLUMN IF NOT EXISTS `whatsapp` VARCHAR(20) NULL,
  ADD COLUMN IF NOT EXISTS `bank_name` VARCHAR(80) NULL,
  ADD COLUMN IF NOT EXISTS `bank_branch` VARCHAR(80) NULL,
  ADD COLUMN IF NOT EXISTS `ifsc` VARCHAR(11) NULL,
  ADD COLUMN IF NOT EXISTS `bank_account_enc` TEXT NULL,
  ADD COLUMN IF NOT EXISTS `pan_enc` TEXT NULL,
  ADD COLUMN IF NOT EXISTS `aadhaar_enc` TEXT NULL,
  ADD COLUMN IF NOT EXISTS `place` VARCHAR(80) NULL,
  ADD COLUMN IF NOT EXISTS `agreed_terms_at` DATETIME(3) NULL,
  ADD COLUMN IF NOT EXISTS `terms_version` VARCHAR(20) NULL,
  ADD COLUMN IF NOT EXISTS `designation` VARCHAR(80) NULL,
  ADD COLUMN IF NOT EXISTS `commission` VARCHAR(80) NULL,
  ADD COLUMN IF NOT EXISTS `travel_allowance` VARCHAR(80) NULL,
  ADD COLUMN IF NOT EXISTS `superior` VARCHAR(120) NULL;

CREATE UNIQUE INDEX IF NOT EXISTS `CpApplication_company_id_partner_no_key`
  ON `CpApplication` (`company_id`, `partner_no`);
