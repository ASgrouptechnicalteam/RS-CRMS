-- CreateTable
CREATE TABLE `Company` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `property_type_group` VARCHAR(191) NOT NULL DEFAULT 'RADHA_REAL_HOMES',
    `announcement_image_url` TEXT NULL,
    `announcement_active` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,

    UNIQUE INDEX `Company_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Branch` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `company_id` INTEGER NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,

    INDEX `Branch_company_id_idx`(`company_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Employee` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `employee_code` VARCHAR(191) NOT NULL,
    `company_id` INTEGER NOT NULL,
    `branch_id` INTEGER NULL,
    `password_hash` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'ACTIVE',
    `token_version` INTEGER NOT NULL DEFAULT 1,
    `attendance_required` BOOLEAN NOT NULL DEFAULT true,
    `first_login_done` BOOLEAN NOT NULL DEFAULT false,
    `full_name` VARCHAR(191) NULL,
    `phone` VARCHAR(191) NULL,
    `secondary_phone` VARCHAR(191) NULL,
    `whatsapp_number` VARCHAR(191) NULL,
    `email` VARCHAR(191) NULL,
    `blood_group` VARCHAR(191) NULL,
    `social_links` VARCHAR(191) NULL,
    `current_address` VARCHAR(191) NULL,
    `permanent_address` VARCHAR(191) NULL,
    `emergency_contact_name` VARCHAR(191) NULL,
    `emergency_contact_relation` VARCHAR(191) NULL,
    `emergency_contact_phone` VARCHAR(191) NULL,
    `pan_number` VARCHAR(191) NULL,
    `aadhaar_number` VARCHAR(191) NULL,
    `bank_name` VARCHAR(191) NULL,
    `bank_account_number` VARCHAR(191) NULL,
    `bank_ifsc` VARCHAR(191) NULL,
    `bank_branch` VARCHAR(191) NULL,
    `job_title` VARCHAR(191) NULL,
    `department` VARCHAR(191) NULL,
    `employment_type` VARCHAR(191) NULL DEFAULT 'FULL_TIME',
    `reporting_manager_id` INTEGER NULL,
    `date_of_joining` DATETIME(3) NULL,
    `salary_ctc` FLOAT NULL,
    `background_education` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,

    UNIQUE INDEX `Employee_employee_code_key`(`employee_code`),
    INDEX `Employee_company_id_idx`(`company_id`),
    INDEX `Employee_branch_id_idx`(`branch_id`),
    INDEX `Employee_reporting_manager_id_idx`(`reporting_manager_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `EmployeeRole` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `employee_id` INTEGER NOT NULL,
    `role` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,

    INDEX `EmployeeRole_employee_id_idx`(`employee_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `EmployeeBranch` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `employee_id` INTEGER NOT NULL,
    `branch_id` INTEGER NOT NULL,
    `is_primary` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,

    INDEX `EmployeeBranch_employee_id_idx`(`employee_id`),
    INDEX `EmployeeBranch_branch_id_idx`(`branch_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `EmployeePermissionOverride` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `employee_id` INTEGER NOT NULL,
    `permission` VARCHAR(191) NOT NULL,
    `value` BOOLEAN NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,

    INDEX `EmployeePermissionOverride_employee_id_idx`(`employee_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `EmployeeQrCode` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `employee_id` INTEGER NOT NULL,
    `slug` VARCHAR(191) NOT NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,

    UNIQUE INDEX `EmployeeQrCode_slug_key`(`slug`),
    INDEX `EmployeeQrCode_employee_id_idx`(`employee_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `DailyTarget` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `employee_id` INTEGER NOT NULL,
    `date` DATE NOT NULL,
    `target_value` FLOAT NOT NULL,
    `actual_value` FLOAT NULL,
    `target_type` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,

    INDEX `DailyTarget_employee_id_date_idx`(`employee_id`, `date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AttendanceLog` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `employee_id` INTEGER NOT NULL,
    `date` DATE NOT NULL,
    `status` VARCHAR(191) NOT NULL,
    `check_in` DATETIME(3) NULL,
    `check_out` DATETIME(3) NULL,
    `late_minutes` INTEGER NULL,
    `half_day` BOOLEAN NOT NULL DEFAULT false,
    `notes` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,

    INDEX `AttendanceLog_employee_id_date_idx`(`employee_id`, `date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `DailyReport` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `employee_id` INTEGER NOT NULL,
    `date` DATE NOT NULL,
    `report_type` VARCHAR(191) NOT NULL,
    `content` TEXT NULL,
    `attachments` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,

    INDEX `DailyReport_employee_id_date_idx`(`employee_id`, `date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Task` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `company_id` INTEGER NOT NULL,
    `branch_id` INTEGER NULL,
    `title` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'OPEN',
    `priority` VARCHAR(191) NOT NULL DEFAULT 'MEDIUM',
    `due_date` DATETIME(3) NULL,
    `created_by` INTEGER NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,

    INDEX `Task_company_id_idx`(`company_id`),
    INDEX `Task_branch_id_idx`(`branch_id`),
    INDEX `Task_created_by_idx`(`created_by`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Lead` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `company_id` INTEGER NOT NULL,
    `branch_id` INTEGER NULL,
    `assigned_to_id` INTEGER NULL,
    `lead_code` VARCHAR(191) NOT NULL,
    `first_name` VARCHAR(191) NOT NULL,
    `last_name` VARCHAR(191) NULL,
    `phone` VARCHAR(191) NULL,
    `secondary_phone` VARCHAR(191) NULL,
    `email` VARCHAR(191) NULL,
    `whatsapp_number` VARCHAR(191) NULL,
    `source` VARCHAR(191) NOT NULL DEFAULT 'MANUAL_ENTRY',
    `campaign` VARCHAR(191) NULL,
    `utm_source` VARCHAR(191) NULL,
    `utm_medium` VARCHAR(191) NULL,
    `utm_campaign` VARCHAR(191) NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'NEW',
    `notes` TEXT NULL,
    `priority` VARCHAR(191) NULL,
    `expected_property_type` VARCHAR(191) NULL,
    `expected_budget_min` FLOAT NULL,
    `expected_budget_max` FLOAT NULL,
    `expected_location` VARCHAR(191) NULL,
    `expected_bedrooms` INTEGER NULL,
    `lead_assign_reason` TEXT NULL,
    `exit_reason` TEXT NULL,
    `exited_from_status` VARCHAR(191) NULL,
    `demo_scheduled_at` DATETIME(3) NULL,
    `demo_handler_id` INTEGER NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,

    UNIQUE INDEX `Lead_lead_code_key`(`lead_code`),
    INDEX `Lead_company_id_idx`(`company_id`),
    INDEX `Lead_branch_id_idx`(`branch_id`),
    INDEX `Lead_assigned_to_id_idx`(`assigned_to_id`),
    INDEX `Lead_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Branch` ADD CONSTRAINT `Branch_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `Company`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Employee` ADD CONSTRAINT `Employee_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `Company`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Employee` ADD CONSTRAINT `Employee_branch_id_fkey` FOREIGN KEY (`branch_id`) REFERENCES `Branch`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Employee` ADD CONSTRAINT `Employee_reporting_manager_id_fkey` FOREIGN KEY (`reporting_manager_id`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE `LeadActivity` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `lead_id` INTEGER NOT NULL,
    `actor_id` INTEGER NOT NULL,
    `activity_type` VARCHAR(191) NOT NULL,
    `notes` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,

    INDEX `LeadActivity_lead_id_idx`(`lead_id`),
    INDEX `LeadActivity_actor_id_idx`(`actor_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `LeadMatchingRequirement` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `lead_id` INTEGER NOT NULL,
    `property_type` VARCHAR(191) NOT NULL,
    `location` VARCHAR(191) NOT NULL,
    `max_budget` FLOAT NOT NULL,
    `min_bedrooms` INTEGER NULL,
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `LeadMatchingRequirement_lead_id_idx`(`lead_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `LeadPropertyInterest` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `lead_id` INTEGER NOT NULL,
    `property_id` INTEGER NOT NULL,
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `created_by` INTEGER NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,

    UNIQUE INDEX `LeadPropertyInterest_lead_id_property_id_key`(`lead_id`, `property_id`),
    INDEX `LeadPropertyInterest_property_id_idx`(`property_id`),
    INDEX `LeadPropertyInterest_created_by_idx`(`created_by`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Project` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `project_code` VARCHAR(191) NOT NULL,
    `company_id` INTEGER NOT NULL,
    `branch_id` INTEGER NULL,
    `name` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `location` VARCHAR(191) NOT NULL,
    `total_area` VARCHAR(191) NULL,
    `launch_date` DATETIME(3) NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'PLANNING',
    `amenities` JSON NULL,
    `assigned_pm_id` INTEGER NULL,
    `slug` VARCHAR(191) NOT NULL DEFAULT(uuid()),
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,

    UNIQUE INDEX `Project_project_code_key`(`project_code`),
    INDEX `Project_company_id_idx`(`company_id`),
    INDEX `Project_branch_id_idx`(`branch_id`),
    INDEX `Project_assigned_pm_id_idx`(`assigned_pm_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Property` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `property_code` VARCHAR(191) NOT NULL,
    `project_id` INTEGER NULL,
    `company_id` INTEGER NOT NULL,
    `branch_id` INTEGER NULL,
    `title` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `brand_type` VARCHAR(191) NOT NULL DEFAULT 'SONTHILLU',
    `category` VARCHAR(191) NOT NULL DEFAULT 'VILLA',
    `price` FLOAT NOT NULL,
    `area_sqft` FLOAT NOT NULL,
    `location` VARCHAR(191) NOT NULL,
    `address` TEXT NULL,
    `bedrooms` INTEGER NULL,
    `bathrooms` INTEGER NULL,
    `facing` VARCHAR(191) NULL,
    `details` JSON NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'PENDING_VERIFICATION',
    `assigned_pm_id` INTEGER NULL,
    `created_by_id` INTEGER NOT NULL,
    `verified_by_pm_at` DATETIME(3) NULL,
    `dm_polished_at` DATETIME(3) NULL,
    `md_approved_at` DATETIME(3) NULL,
    `rejection_reason` TEXT NULL,
    `seo_title` VARCHAR(191) NULL,
    `seo_keywords` VARCHAR(191) NULL,
    `amenities` TEXT NULL,
    `state` VARCHAR(191) NULL,
    `city` VARCHAR(191) NULL,
    `locality` VARCHAR(191) NULL,
    `pincode` VARCHAR(191) NULL,
    `latitude` FLOAT NULL,
    `longitude` FLOAT NULL,
    `listing_type` VARCHAR(191) NULL DEFAULT 'NEW',
    `possession_status` VARCHAR(191) NULL,
    `slug` VARCHAR(191) NULL,
    `locked_until` DATETIME(3) NULL,
    `locked_by_booking_id` INTEGER NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,

    UNIQUE INDEX `Property_property_code_key`(`property_code`),
    INDEX `Property_project_id_idx`(`project_id`),
    INDEX `Property_company_id_idx`(`company_id`),
    INDEX `Property_branch_id_idx`(`branch_id`),
    INDEX `Property_assigned_pm_id_idx`(`assigned_pm_id`),
    INDEX `Property_status_idx`(`status`),
    UNIQUE INDEX `Property_slug_key`(`slug`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PropertyImage` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `property_id` INTEGER NOT NULL,
    `image_url` VARCHAR(191) NOT NULL,
    `is_primary` BOOLEAN NOT NULL DEFAULT false,
    `uploaded_by_id` INTEGER NOT NULL,
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `alt_text` VARCHAR(191) NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'PENDING',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,

    INDEX `PropertyImage_property_id_idx`(`property_id`),
    INDEX `PropertyImage_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PropertyPublication` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `property_id` INTEGER NOT NULL,
    `company_id` INTEGER NOT NULL,
    `is_published` BOOLEAN NOT NULL DEFAULT false,
    `published_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,

    UNIQUE INDEX `PropertyPublication_property_id_company_id_key`(`property_id`, `company_id`),
    INDEX `PropertyPublication_company_id_idx`(`company_id`),
    INDEX `PropertyPublication_property_id_idx`(`property_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PropertyVerificationLog` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `property_id` INTEGER NOT NULL,
    `actor_id` INTEGER NOT NULL,
    `from_status` VARCHAR(191) NOT NULL,
    `to_status` VARCHAR(191) NOT NULL,
    `notes` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,

    INDEX `PropertyVerificationLog_property_id_idx`(`property_id`),
    INDEX `PropertyVerificationLog_actor_id_idx`(`actor_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SiteVisitBooking` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `booking_code` VARCHAR(191) NOT NULL,
    `lead_id` INTEGER NOT NULL,
    `property_id` INTEGER NOT NULL,
    `assigned_to` INTEGER NULL,
    `customer_id` INTEGER NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'REQUESTED',
    `visit_date` DATETIME(3) NULL,
    `visit_time` VARCHAR(191) NULL,
    `duration_minutes` INTEGER NULL,
    `purpose` TEXT NULL,
    `current_location` VARCHAR(191) NULL,
    `parking_info` VARCHAR(191) NULL,
    `special_instructions` TEXT NULL,
    `repeat_visits_count` INTEGER NOT NULL DEFAULT 0,
    `last_visit_date` DATETIME(3) NULL,
    `next_visit_date` DATETIME(3) NULL,
    `visit_status_details` JSON NULL,
    `cancellation_reason` TEXT NULL,
    `rejection_reason` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,
    `rescheduled_at` DATETIME(3) NULL,
    `accepted_at` DATETIME(3) NULL,
    `cancelled_at` DATETIME(3) NULL,
    `rejected_at` DATETIME(3) NULL,

    UNIQUE INDEX `SiteVisitBooking_booking_code_key`(`booking_code`),
    INDEX `SiteVisitBooking_lead_id_idx`(`lead_id`),
    INDEX `SiteVisitBooking_property_id_idx`(`property_id`),
    INDEX `SiteVisitBooking_assigned_to_idx`(`assigned_to`),
    INDEX `SiteVisitBooking_customer_id_idx`(`customer_id`),
    INDEX `SiteVisitBooking_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SiteVisitProperty` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `visit_id` INTEGER NOT NULL,
    `property_id` INTEGER NOT NULL,
    `visit_order` INTEGER NOT NULL,
    `visit_duration_minutes` INTEGER NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'PENDING',
    `notes` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,

    UNIQUE INDEX `SiteVisitProperty_visit_id_property_id_key`(`visit_id`, `property_id`),
    INDEX `SiteVisitProperty_visit_id_idx`(`visit_id`),
    INDEX `SiteVisitProperty_property_id_idx`(`property_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SiteVisitReassignment` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `visit_id` INTEGER NOT NULL,
    `from_employee_id` INTEGER NULL,
    `to_employee_id` INTEGER NULL,
    `reason` TEXT NULL,
    `outcome` VARCHAR(191) NULL,
    `issue_date` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `outcome_reason` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,

    INDEX `SiteVisitReassignment_visit_id_idx`(`visit_id`),
    INDEX `SiteVisitReassignment_from_employee_id_idx`(`from_employee_id`),
    INDEX `SiteVisitReassignment_to_employee_id_idx`(`to_employee_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `MessageTemplate` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `template_key` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `body_text` TEXT NOT NULL,
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,

    UNIQUE INDEX `MessageTemplate_template_key_key`(`template_key`),
    INDEX `MessageTemplate_template_key_idx`(`template_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Customer` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `company_id` INTEGER NOT NULL,
    `branch_id` INTEGER NULL,
    `assigned_to_id` INTEGER NULL,
    `customer_code` VARCHAR(191) NOT NULL,
    `first_name` VARCHAR(191) NOT NULL,
    `last_name` VARCHAR(191) NULL,
    `phone` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'ACTIVE',
    `source` VARCHAR(191) NOT NULL DEFAULT 'MANUAL_ENTRY',
    `campaign` VARCHAR(191) NULL,
    `utm_source` VARCHAR(191) NULL,
    `utm_medium` VARCHAR(191) NULL,
    `utm_campaign` VARCHAR(191) NULL,
    `origin_lead_id` INTEGER NULL,
    `pan_number` VARCHAR(191) NULL,
    `aadhaar_number` VARCHAR(191) NULL,
    `kyc_status` VARCHAR(191) NULL,
    `kyc_verified_at` DATETIME(3) NULL,
    `kyc_rejected_reason` TEXT NULL,
    `kyc_submission_status` VARCHAR(191) NULL,
    `kyc_submitted_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,

    UNIQUE INDEX `Customer_customer_code_key`(`customer_code`),
    INDEX `Customer_company_id_idx`(`company_id`),
    INDEX `Customer_branch_id_idx`(`branch_id`),
    INDEX `Customer_assigned_to_id_idx`(`assigned_to_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Booking` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `booking_code` VARCHAR(191) NOT NULL UNIQUE,
    `company_id` INTEGER NOT NULL,
    `branch_id` INTEGER NULL,
    `customer_id` INTEGER NOT NULL,
    `property_id` INTEGER NOT NULL,
    `assigned_employee_id` INTEGER NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'PENDING',
    `agreed_price` FLOAT NOT NULL,
    `booking_amount` FLOAT NOT NULL,
    `balance_amount` FLOAT NOT NULL,
    `booking_date` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `source` VARCHAR(191) NULL,
    `campaign` VARCHAR(191) NULL,
    `utm_source` VARCHAR(191) NULL,
    `utm_medium` VARCHAR(191) NULL,
    `utm_campaign` VARCHAR(191) NULL,
    `notes` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,

    INDEX `Booking_company_id_idx`(`company_id`),
    INDEX `Booking_branch_id_idx`(`branch_id`),
    INDEX `Booking_customer_id_idx`(`customer_id`),
    INDEX `Booking_property_id_idx`(`property_id`),
    INDEX `Booking_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Payment` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `payment_code` VARCHAR(191) NOT NULL,
    `company_id` INTEGER NOT NULL,
    `booking_id` INTEGER NOT NULL,
    `installment_id` INTEGER NULL,
    `amount` FLOAT NOT NULL,
    `payment_method` VARCHAR(191) NOT NULL DEFAULT 'CASH',
    `payment_date` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `transaction_id` VARCHAR(191) NULL,
    `notes` TEXT NULL,
    `receipt_text` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,

    UNIQUE INDEX `Payment_payment_code_key`(`payment_code`),
    INDEX `Payment_company_id_idx`(`company_id`),
    INDEX `Payment_booking_id_idx`(`booking_id`),
    INDEX `Payment_installment_id_idx`(`installment_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Installment` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `booking_id` INTEGER NOT NULL,
    `customer_id` INTEGER NOT NULL,
    `due_date` DATE NOT NULL,
    `amount_due` FLOAT NOT NULL,
    `amount_paid` FLOAT NOT NULL DEFAULT 0,
    `status` VARCHAR(191) NOT NULL DEFAULT 'PENDING',
    `verified_at` DATETIME(3) NULL,
    `verified_by` INTEGER NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,

    INDEX `Installment_booking_id_idx`(`booking_id`),
    INDEX `Installment_customer_id_idx`(`customer_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Opportunity` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `opportunity_code` VARCHAR(191) NOT NULL,
    `lead_id` INTEGER NOT NULL,
    `company_id` INTEGER NOT NULL,
    `customer_id` INTEGER NULL,
    `property_id` INTEGER NULL,
    `project_id` INTEGER NULL,
    `booking_id` INTEGER NULL,
    `stage` VARCHAR(191) NOT NULL DEFAULT 'QUALIFIED',
    `probability` FLOAT NULL DEFAULT 10.0,
    `expected_value` FLOAT NULL,
    `budget_min` FLOAT NULL,
    `budget_max` FLOAT NULL,
    `expected_close_date` DATETIME(3) NULL,
    `drop_reason` TEXT NULL,
    `owner_id` INTEGER NOT NULL,
    `source` VARCHAR(191) NULL,
    `campaign` VARCHAR(191) NULL,
    `utm_source` VARCHAR(191) NULL,
    `utm_medium` VARCHAR(191) NULL,
    `utm_campaign` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,

    UNIQUE INDEX `Opportunity_opportunity_code_key`(`opportunity_code`),
    INDEX `Opportunity_company_id_idx`(`company_id`),
    INDEX `Opportunity_lead_id_idx`(`lead_id`),
    INDEX `Opportunity_stage_idx`(`stage`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OpportunityHistory` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `opportunity_id` INTEGER NOT NULL,
    `previous_stage` VARCHAR(191) NULL,
    `new_stage` VARCHAR(191) NOT NULL,
    `actor_id` INTEGER NOT NULL,
    `notes` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,

    INDEX `OpportunityHistory_opportunity_id_idx`(`opportunity_id`),
    INDEX `OpportunityHistory_actor_id_idx`(`actor_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AuditEvent` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `actor_id` INTEGER NOT NULL,
    `action` VARCHAR(191) NOT NULL,
    `entity_type` VARCHAR(191) NOT NULL,
    `entity_id` INTEGER NOT NULL,
    `old_value` VARCHAR(191) NULL,
    `new_value` VARCHAR(191) NULL,
    `reason` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,

    INDEX `AuditEvent_actor_id_idx`(`actor_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CompanyNotification` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `company_id` INTEGER NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `is_read` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,

    INDEX `CompanyNotification_company_id_idx`(`company_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CustomerNotification` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `customer_id` INTEGER NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `is_read` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,

    INDEX `CustomerNotification_customer_id_idx`(`customer_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Complaint` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `title` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'OPEN',
    `complaint_type` VARCHAR(191) NOT NULL DEFAULT 'GENERAL',
    `company_id` INTEGER NULL,
    `branch_id` INTEGER NULL,
    `customer_id` INTEGER NULL,
    `property_id` INTEGER NULL,
    `booking_id` INTEGER NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,

    INDEX `Complaint_company_id_idx`(`company_id`),
    INDEX `Complaint_branch_id_idx`(`branch_id`),
    INDEX `Complaint_customer_id_idx`(`customer_id`),
    INDEX `Complaint_property_id_idx`(`property_id`),
    INDEX `Complaint_booking_id_idx`(`booking_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `EmployeeNotification` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `employee_id` INTEGER NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `is_read` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,

    INDEX `EmployeeNotification_employee_id_idx`(`employee_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CustomerSourceReferral` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `customer_id` INTEGER NOT NULL,
    `company_id` INTEGER NOT NULL,
    `source_name` VARCHAR(191) NOT NULL,
    `source_type` VARCHAR(191) NOT NULL DEFAULT 'REFERRAL',
    `description` TEXT NULL,
    `commission_eligible` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,

    INDEX `CustomerSourceReferral_customer_id_idx`(`customer_id`),
    INDEX `CustomerSourceReferral_company_id_idx`(`company_id`),
    INDEX `CustomerSourceReferral_source_name_idx`(`source_name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `LeadPropertyInterest` ADD CONSTRAINT `LeadPropertyInterest_lead_id_fkey` FOREIGN KEY (`lead_id`) REFERENCES `Lead`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LeadPropertyInterest` ADD CONSTRAINT `LeadPropertyInterest_property_id_fkey` FOREIGN KEY (`property_id`) REFERENCES `Property`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LeadPropertyInterest` ADD CONSTRAINT `LeadPropertyInterest_created_by_fkey` FOREIGN KEY (`created_by`) REFERENCES `Employee`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Project` ADD CONSTRAINT `Project_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `Company`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Project` ADD CONSTRAINT `Project_branch_id_fkey` FOREIGN KEY (`branch_id`) REFERENCES `Branch`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Project` ADD CONSTRAINT `Project_assigned_pm_id_fkey` FOREIGN KEY (`assigned_pm_id`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Property` ADD CONSTRAINT `Property_project_id_fkey` FOREIGN KEY (`project_id`) REFERENCES `Project`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Property` ADD CONSTRAINT `Property_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `Company`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Property` ADD CONSTRAINT `Property_branch_id_fkey` FOREIGN KEY (`branch_id`) REFERENCES `Branch`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Property` ADD CONSTRAINT `Property_assigned_pm_id_fkey` FOREIGN KEY (`assigned_pm_id`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Property` ADD CONSTRAINT `Property_created_by_id_fkey` FOREIGN KEY (`created_by_id`) REFERENCES `Employee`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Property` ADD CONSTRAINT `Property_locked_by_booking_id_fkey` FOREIGN KEY (`locked_by_booking_id`) REFERENCES `Booking`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PropertyImage` ADD CONSTRAINT `PropertyImage_property_id_fkey` FOREIGN KEY (`property_id`) REFERENCES `Property`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PropertyImage` ADD CONSTRAINT `PropertyImage_uploaded_by_id_fkey` FOREIGN KEY (`uploaded_by_id`) REFERENCES `Employee`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PropertyPublication` ADD CONSTRAINT `PropertyPublication_property_id_fkey` FOREIGN KEY (`property_id`) REFERENCES `Property`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PropertyPublication` ADD CONSTRAINT `PropertyPublication_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `Company`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PropertyVerificationLog` ADD CONSTRAINT `PropertyVerificationLog_property_id_fkey` FOREIGN KEY (`property_id`) REFERENCES `Property`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PropertyVerificationLog` ADD CONSTRAINT `PropertyVerificationLog_actor_id_fkey` FOREIGN KEY (`actor_id`) REFERENCES `Employee`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SiteVisitBooking` ADD CONSTRAINT `SiteVisitBooking_lead_id_fkey` FOREIGN KEY (`lead_id`) REFERENCES `Lead`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SiteVisitBooking` ADD CONSTRAINT `SiteVisitBooking_property_id_fkey` FOREIGN KEY (`property_id`) REFERENCES `Property`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SiteVisitBooking` ADD CONSTRAINT `SiteVisitBooking_assigned_to_fkey` FOREIGN KEY (`assigned_to`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SiteVisitBooking` ADD CONSTRAINT `SiteVisitBooking_customer_id_fkey` FOREIGN KEY (`customer_id`) REFERENCES `Customer`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SiteVisitProperty` ADD CONSTRAINT `SiteVisitProperty_visit_id_fkey` FOREIGN KEY (`visit_id`) REFERENCES `SiteVisitBooking`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SiteVisitProperty` ADD CONSTRAINT `SiteVisitProperty_property_id_fkey` FOREIGN KEY (`property_id`) REFERENCES `Property`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SiteVisitReassignment` ADD CONSTRAINT `SiteVisitReassignment_visit_id_fkey` FOREIGN KEY (`visit_id`) REFERENCES `SiteVisitBooking`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SiteVisitReassignment` ADD CONSTRAINT `SiteVisitReassignment_from_employee_id_fkey` FOREIGN KEY (`from_employee_id`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SiteVisitReassignment` ADD CONSTRAINT `SiteVisitReassignment_to_employee_id_fkey` FOREIGN KEY (`to_employee_id`) REFERENCES `Employee`(`id`) ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Customer` ADD CONSTRAINT `Customer_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `Company`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Customer` ADD CONSTRAINT `Customer_branch_id_fkey` FOREIGN KEY (`branch_id`) REFERENCES `Branch`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Customer` ADD CONSTRAINT `Customer_assigned_to_id_fkey` FOREIGN KEY (`assigned_to_id`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Customer` ADD CONSTRAINT `Customer_origin_lead_id_fkey` FOREIGN KEY (`origin_lead_id`) REFERENCES `Lead`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Booking` ADD CONSTRAINT `Booking_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `Company`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Booking` ADD CONSTRAINT `Booking_branch_id_fkey` FOREIGN KEY (`branch_id`) REFERENCES `Branch`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Booking` ADD CONSTRAINT `Booking_customer_id_fkey` FOREIGN KEY (`customer_id`) REFERENCES `Customer`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Booking` ADD CONSTRAINT `Booking_property_id_fkey` FOREIGN KEY (`property_id`) REFERENCES `Property`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Booking` ADD CONSTRAINT `Booking_assigned_employee_id_fkey` FOREIGN KEY (`assigned_employee_id`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Payment` ADD CONSTRAINT `Payment_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `Company`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Payment` ADD CONSTRAINT `Payment_booking_id_fkey` FOREIGN KEY (`booking_id`) REFERENCES `Booking`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Payment` ADD CONSTRAINT `Payment_installment_id_fkey` FOREIGN KEY (`installment_id`) REFERENCES `Installment`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Installment` ADD CONSTRAINT `Installment_booking_id_fkey` FOREIGN KEY (`booking_id`) REFERENCES `Booking`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Installment` ADD CONSTRAINT `Installment_customer_id_fkey` FOREIGN KEY (`customer_id`) REFERENCES `Customer`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Opportunity` ADD CONSTRAINT `Opportunity_lead_id_fkey` FOREIGN KEY (`lead_id`) REFERENCES `Lead`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Opportunity` ADD CONSTRAINT `Opportunity_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `Company`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
