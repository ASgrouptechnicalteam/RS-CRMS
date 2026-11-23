-- Associate registration form: the same table as the channel partner form, told apart by a "kind" column,
-- plus a link to the Associate made when someone is onboarded. Safe to run twice. Run each statement on its own
-- in phpMyAdmin. Live database: u988844918_CRM_API. Test database: u988844918_RSCRM (change the USE line).
SET NAMES utf8mb4;
USE `u988844918_CRM_API`;

ALTER TABLE `CpApplication`
  ADD COLUMN IF NOT EXISTS `kind` VARCHAR(12) NOT NULL DEFAULT 'CP',
  ADD COLUMN IF NOT EXISTS `associate_id` INT NULL;

-- The same phone or number may exist once as a channel partner and once as an associate.
DROP INDEX IF EXISTS `CpApplication_company_id_phone_key` ON `CpApplication`;
DROP INDEX IF EXISTS `CpApplication_company_id_partner_no_key` ON `CpApplication`;
CREATE UNIQUE INDEX IF NOT EXISTS `CpApplication_company_id_kind_phone_key` ON `CpApplication` (`company_id`, `kind`, `phone`);
CREATE UNIQUE INDEX IF NOT EXISTS `CpApplication_company_id_kind_partner_no_key` ON `CpApplication` (`company_id`, `kind`, `partner_no`);
CREATE UNIQUE INDEX IF NOT EXISTS `CpApplication_associate_id_key` ON `CpApplication` (`associate_id`);
