-- Run-once lock for scheduled jobs: one small table, nothing existing changes. Safe to run twice.
-- The server works without it (jobs just run as before and one warning is logged), so this can be run before or
-- after the code is released. Live database: u988844918_CRM_API. Test database: u988844918_RSCRM (change the USE line).
SET NAMES utf8mb4;
USE `u988844918_CRM_API`;

CREATE TABLE IF NOT EXISTS `JobLock` (
  `name` VARCHAR(100) NOT NULL,
  `locked_until` DATETIME(3) NOT NULL,
  `holder` VARCHAR(120) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`name`)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
