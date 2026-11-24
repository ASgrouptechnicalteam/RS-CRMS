-- New project type "Residential plots" (RESIDENTIAL_PLOTS). The project type is a fixed list in the database, so the
-- new value must be added to it BEFORE the new website and server are released (otherwise saving a project of this
-- type fails). The value is added at the END of the list, which MySQL/MariaDB does instantly without rewriting the
-- table. Safe to run twice (same list again). Nothing existing changes: every current project keeps its type.
-- Live database: u988844918_CRM_API. Test database: u988844918_RSCRM (change the USE line).
--
-- CHECK FIRST (run on its own; the column must be exactly the 16 values below, nullable, no default):
--   SELECT column_type, is_nullable, column_default FROM information_schema.columns
--   WHERE table_schema = DATABASE() AND table_name = 'Project' AND column_name = 'project_type';
-- UNDO (only if no project uses the new type): run the statement again without ,'RESIDENTIAL_PLOTS'.
SET NAMES utf8mb4;
USE `u988844918_CRM_API`;

ALTER TABLE `Project`
  MODIFY COLUMN `project_type` ENUM('PLOTTED','APARTMENT','VILLA','INDEPENDENT_HOUSE','ROW_HOUSE','AGRICULTURAL_LAND','FARM_HOUSE','COMMERCIAL_SHOP','COMMERCIAL_OFFICE','MIXED_RESIDENTIAL','MIXED_USE','TOWNSHIP','GATED_COMMUNITY','MIXED','COMMERCIAL','OTHER','RESIDENTIAL_PLOTS') NULL;
