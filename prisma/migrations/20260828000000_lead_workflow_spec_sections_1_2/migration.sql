-- AlterTable — change the column default only (type stays VARCHAR(191))
ALTER TABLE `sitevisitbooking` ALTER COLUMN `status` SET DEFAULT 'REQUESTED';

-- AlterTable — add project_id for §2 PM routing (all linked properties share one project)
ALTER TABLE `sitevisitbooking` ADD COLUMN `project_id` INTEGER NULL;

-- AddForeignKey
ALTER TABLE `sitevisitbooking` ADD CONSTRAINT `sitevisitbooking_project_id_fkey`
    FOREIGN KEY (`project_id`) REFERENCES `Project`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
