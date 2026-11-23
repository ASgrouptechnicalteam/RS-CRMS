-- Channel partner registration form: profile photo and "give partner access" link. Only adds columns; safe to run twice.
-- Live database: u988844918_CRM_API. Test database: u988844918_RSCRM. Change the USE line for test.
SET NAMES utf8mb4;
USE `u988844918_CRM_API`;

ALTER TABLE `CpApplication`
  ADD COLUMN IF NOT EXISTS `photo_data` MEDIUMTEXT NULL,
  ADD COLUMN IF NOT EXISTS `photo_thumb` TEXT NULL,
  ADD COLUMN IF NOT EXISTS `employee_id` INT NULL,
  ADD COLUMN IF NOT EXISTS `access_given_at` DATETIME(3) NULL,
  ADD COLUMN IF NOT EXISTS `access_given_by` INT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS `CpApplication_employee_id_key` ON `CpApplication` (`employee_id`);
