-- Partner customer screens (2026-11-26): how interested the customer is, why a call failed, and why a customer was
-- closed. Four new empty columns; nothing existing changes. Safe to run twice. Run BEFORE the new server.
-- Live database: u988844918_CRM_API. Test database: u988844918_RSCRM (change the USE line).
SET NAMES utf8mb4;
USE `u988844918_CRM_API`;

ALTER TABLE `CpLead`
  ADD COLUMN IF NOT EXISTS `interest` VARCHAR(10) NULL,
  ADD COLUMN IF NOT EXISTS `exit_reason` VARCHAR(40) NULL;

ALTER TABLE `CpLeadActivity`
  ADD COLUMN IF NOT EXISTS `call_reason` VARCHAR(40) NULL,
  ADD COLUMN IF NOT EXISTS `interest` VARCHAR(10) NULL;
