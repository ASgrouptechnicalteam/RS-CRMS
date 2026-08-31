-- Add report_required Boolean to Employee
ALTER TABLE `Employee` ADD COLUMN `report_required` BOOLEAN NOT NULL DEFAULT true AFTER `first_login_done`;
