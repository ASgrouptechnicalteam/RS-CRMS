"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DocumentArchiveSchema = exports.DocumentVerifySchema = exports.DocumentUploadSchema = exports.DOCUMENT_TYPE_ENTITY_REQUIREMENTS = exports.DocumentVerificationStatus = exports.DocumentStatus = exports.DocumentType = exports.CustomerUpdateSchema = exports.CustomerCreateSchema = exports.ExpenseRefundMarkRefundedSchema = exports.ExpenseRefundMDReviewSchema = exports.ExpenseRefundAccountantReviewSchema = exports.ExpenseRefundCreateSchema = exports.ExpenseRefundStatus = exports.PropertyPublicationSchema = exports.PropertyUpdateSchema = exports.PropertyMDApprovalSchema = exports.PropertyDMVerifyAsIsSchema = exports.PropertyDMUpdateSchema = exports.PropertyVerificationSchema = exports.PropertyCreateSchema = exports.PropertyBrand = exports.PropertyAvailability = exports.PropertyStatus = exports.AddPropertyInterestSchema = exports.ProjectUpdateSchema = exports.ProjectCreateSchema = exports.LeadReassignSchema = exports.LeadStatusUpdateSchema = exports.PublicLeadCreateSchema = exports.LeadCreateSchema = exports.LeadSource = exports.LeadStatus = exports.TaskUpdateStatusSchema = exports.TaskCreateSchema = exports.DailyTargetSetSchema = exports.DailyReportSchema = exports.TaskStatus = exports.TaskPriority = exports.LeaveProposalSchema = exports.LateProposalSchema = exports.ChangePasswordSchema = exports.AttendanceStatus = exports.LoginSchema = exports.EMPLOYEE_CODE_REGEX = exports.RolePermissionsMatrix = exports.Permissions = exports.DepartmentCodes = exports.Roles = exports.CompanySchema = void 0;
exports.EmployeeRolesUpdateSchema = exports.EmployeeUpdateSchema = exports.EmployeeCreateSchema = exports.EmployeeSelfUpdateSchema = exports.AttendanceHolidaySchema = exports.AttendanceQRPayloadSchema = exports.EmptyBodySchema = exports.PropertyImageMetadataSchema = exports.PropertyTogglePublicationBodySchema = exports.MessageTemplateKey = exports.MessageTemplateSchema = exports.SiteVisitUpdateSchema = exports.SiteVisitCompleteSchema = exports.SiteVisitOutcomeSchema = exports.SiteVisitReconfirmSchema = exports.SiteVisitRescheduleSchema = exports.SiteVisitEscalateSchema = exports.SiteVisitReassignSchema = exports.SiteVisitAcceptSchema = exports.SiteVisitCreateSchema = exports.SiteVisitOutcome = exports.SiteVisitStatus = exports.OpportunityUpdateSchema = exports.OpportunityCreateSchema = exports.IntegrationMetricsResponseSchema = exports.IntegrationMetricsQuerySchema = exports.CustomerNotificationResponseSchema = exports.CustomerNotificationReadSchema = exports.CustomerNotificationType = exports.InstallmentStatusChangedSchema = exports.INSTALLMENT_EVENT_TYPE = exports.PaymentCallbackSchema = exports.PaymentStatusChangedSchema = exports.PAYMENT_EVENT_TYPE = exports.KycCallbackSchema = exports.KycStatusChangedSchema = exports.CustomerKycWriteSchema = exports.KYC_STATUSES = exports.KycStatus = exports.PortalCallbackSchema = exports.PortalCallbackStatus = void 0;
const zod_1 = require("zod");
exports.CompanySchema = zod_1.z.object({
    id: zod_1.z.number().int(),
    name: zod_1.z.string().min(2),
    code: zod_1.z.string(),
    property_type_group: zod_1.z.enum(['RADHA_REAL_HOMES', 'SONTHILLU']),
});
// Roles
exports.Roles = {
    MD: 'Managing director',
    ADMIN: 'Admin (Technical)',
    MARKETING_DIRECTOR: 'marketing director',
    PROJECT_MANAGER: 'project managers',
    DIGITAL_LEAD_OPERATOR: 'Digital lead operator',
    TELECALLER: 'telecallers',
    DIGITAL_MARKETING_HEAD: 'Digital Marketing head(manager)',
    HR_MANAGER: 'HR',
    FINANCE: 'accountant',
    AGENT: 'Agent',
    DIGITAL_MARKETING_EXECUTIVE: 'digital marketing executive',
    SALES_MANAGER: 'Sales manager',
    CHANNEL_PARTNER_MANAGER: 'Channel partner manager'
};
// Permanent 2-Letter Department Codes for Employee IDs: RRH-{DEPT_2DIGIT}-{NUMBER_3DIGIT}
// Employee IDs remain static and permanent for life even when promoted!
exports.DepartmentCodes = {
    [exports.Roles.MD]: 'EX',
    [exports.Roles.ADMIN]: 'EX',
    [exports.Roles.HR_MANAGER]: 'HR',
    [exports.Roles.TELECALLER]: 'SL',
    [exports.Roles.AGENT]: 'SL',
    [exports.Roles.PROJECT_MANAGER]: 'OP',
    [exports.Roles.DIGITAL_MARKETING_EXECUTIVE]: 'MK',
    [exports.Roles.DIGITAL_MARKETING_HEAD]: 'MK',
    [exports.Roles.DIGITAL_LEAD_OPERATOR]: 'MK',
    [exports.Roles.FINANCE]: 'FN',
    [exports.Roles.MARKETING_DIRECTOR]: 'MK',
    [exports.Roles.SALES_MANAGER]: 'SL',
    [exports.Roles.CHANNEL_PARTNER_MANAGER]: 'CP',
};
// Canonical Permissions Model (Phase 1 - Stage 2 Blueprint Section 7)
exports.Permissions = {
    EMPLOYEES_CREATE: 'employees.create',
    EMPLOYEES_READ: 'employees.read',
    EMPLOYEES_UPDATE: 'employees.update',
    EMPLOYEES_DELETE: 'employees.delete',
    EMPLOYEES_VIEW_SENSITIVE: 'employees.view_sensitive',
    EMPLOYEES_MANAGE_DEFAULT_ALL: 'employees.manage_default:all',
    EMPLOYEES_RESET_PASSWORD: 'employees.reset_password',
    LEADS_CREATE: 'leads.create',
    LEADS_READ: 'leads.read',
    LEADS_UPDATE: 'leads.update',
    LEADS_DELETE: 'leads.delete',
    LEADS_ASSIGN: 'leads.assign',
    LEADS_BULK_UPLOAD: 'leads.bulk_upload',
    LEADS_DISTRIBUTION_MONITOR: 'leads.distribution_monitor',
    LEADS_WHATSAPP_PROPOSAL: 'leads.whatsapp_proposal',
    CUSTOMERS_CREATE: 'customers.create',
    CUSTOMERS_READ: 'customers.read',
    CUSTOMERS_UPDATE: 'customers.update',
    CUSTOMERS_DELETE: 'customers.delete',
    CUSTOMERS_CONVERT: 'customers.convert',
    CUSTOMERS_KYC_WRITE: 'customers.kyc_write',
    PROPERTIES_CREATE: 'properties.create',
    PROPERTIES_READ: 'properties.read',
    PROPERTIES_UPDATE: 'properties.update',
    PROPERTIES_DELETE: 'properties.delete',
    PROPERTIES_VERIFY: 'properties.verify',
    PROPERTIES_DM_POLISH: 'properties.dm_polish',
    PROPERTIES_MD_APPROVE: 'properties.md_approve',
    SITE_VISITS_CREATE: 'site_visits.create',
    SITE_VISITS_READ: 'site_visits.read',
    SITE_VISITS_VERIFY: 'site_visits.verify',
    SITE_VISITS_ASSIGN_AGENT: 'site_visits.assign_agent',
    SITE_VISITS_COMPLETE: 'site_visits.complete',
    PROJECTS_CREATE: 'projects.create',
    PROJECTS_READ: 'projects.read',
    PROJECTS_UPDATE: 'projects.update',
    PROJECTS_DELETE: 'projects.delete',
    BOOKINGS_CREATE: 'bookings.create',
    BOOKINGS_READ: 'bookings.read',
    BOOKINGS_UPDATE: 'bookings.update',
    BOOKINGS_CANCEL: 'bookings.cancel',
    BOOKINGS_CONFIRM: 'bookings.confirm',
    PAYMENTS_CREATE: 'payments.create',
    PAYMENTS_READ: 'payments.read',
    PAYMENTS_UPDATE: 'payments.update',
    PAYMENTS_CANCEL: 'payments.cancel',
    TASKS_CREATE: 'tasks.create',
    TASKS_READ: 'tasks.read',
    TASKS_UPDATE: 'tasks.update',
    TASKS_ASSIGN: 'tasks.assign',
    ATTENDANCE_READ_OWN: 'attendance.read_own',
    ATTENDANCE_SCAN: 'attendance.scan',
    ATTENDANCE_LATE_PROPOSAL: 'attendance.late_proposal',
    ATTENDANCE_LEAVE_PROPOSAL: 'attendance.leave_proposal',
    ATTENDANCE_PROPOSALS_QUEUE: 'attendance.proposals_queue',
    ATTENDANCE_LIVE_MONITOR: 'attendance.live_monitor',
    REPORTS_CREATE: 'reports.create',
    REPORTS_READ_OWN: 'reports.read_own',
    REPORTS_READ_TEAM: 'reports.read_team',
    REPORTS_TARGETS_CONFIGURE: 'reports.targets.configure',
    EXPENSES_CREATE: 'expenses.create',
    EXPENSES_READ_OWN: 'expenses.read_own',
    EXPENSES_REVIEW: 'expenses.review',
    EXPENSES_MD_APPROVE: 'expenses.md_approve',
    EXPENSES_MARK_REFUNDED: 'expenses.mark_refunded',
    PERFORMANCE_READ_OWN: 'performance.read_own',
    PERFORMANCE_READ_TEAM: 'performance.read_team',
    PERFORMANCE_HISTORY: 'performance.history',
    ADMIN_SYSTEM_METRICS: 'admin.system_metrics',
    ADMIN_AUDIT_LOGS: 'admin.audit_logs',
    ADMIN_SECURITY_ALERTS: 'admin.security_alerts',
    ADMIN_EMERGENCY_LOCKDOWN: 'admin.emergency_lockdown',
    MESSAGE_TEMPLATES_MANAGE: 'message_templates.manage', // §5 admin template editor
    PUBLIC_PROPERTIES_READ: 'public.properties.read',
    PUBLIC_LEADS_CREATE: 'public.leads.create',
    AI_SEARCH: 'ai.search',
    DOCUMENTS_CREATE: 'documents.create',
    DOCUMENTS_READ: 'documents.read',
    DOCUMENTS_VERIFY: 'documents.verify',
    DOCUMENTS_DELETE: 'documents.delete',
    COMPLAINTS_CREATE: 'complaints.create',
    COMPLAINTS_READ: 'complaints.read',
    COMPLAINTS_UPDATE: 'complaints.update',
    COMPLAINTS_ASSIGN: 'complaints.assign',
    COMPLAINTS_RESOLVE: 'complaints.resolve',
    COMPLAINTS_CLOSE: 'complaints.close',
};
const ALL_PERMISSIONS = Object.values(exports.Permissions);
// Role -> Permission Matrix (Phase 1 - Stage 2 Blueprint Section 8)
exports.RolePermissionsMatrix = {
    [exports.Roles.MD]: ALL_PERMISSIONS, // MD gets all permissions
    [exports.Roles.ADMIN]: ALL_PERMISSIONS,
    [exports.Roles.HR_MANAGER]: [
        exports.Permissions.EMPLOYEES_CREATE,
        exports.Permissions.EMPLOYEES_READ,
        exports.Permissions.EMPLOYEES_UPDATE,
        exports.Permissions.EMPLOYEES_RESET_PASSWORD,
        exports.Permissions.EMPLOYEES_VIEW_SENSITIVE,
        exports.Permissions.ATTENDANCE_PROPOSALS_QUEUE,
        exports.Permissions.ATTENDANCE_LIVE_MONITOR,
        exports.Permissions.TASKS_CREATE,
        exports.Permissions.TASKS_READ,
        exports.Permissions.TASKS_UPDATE,
        exports.Permissions.TASKS_ASSIGN,
        exports.Permissions.REPORTS_READ_TEAM,
        exports.Permissions.PERFORMANCE_READ_TEAM,
        exports.Permissions.DOCUMENTS_CREATE,
        exports.Permissions.DOCUMENTS_READ,
        exports.Permissions.CUSTOMERS_KYC_WRITE,
    ],
    [exports.Roles.FINANCE]: [
        exports.Permissions.EXPENSES_REVIEW,
        exports.Permissions.EXPENSES_MARK_REFUNDED,
        exports.Permissions.EMPLOYEES_VIEW_SENSITIVE, // Finance receives authorized sensitive fields
        exports.Permissions.BOOKINGS_READ,
        exports.Permissions.BOOKINGS_UPDATE,
        exports.Permissions.PAYMENTS_CREATE,
        exports.Permissions.PAYMENTS_READ,
        exports.Permissions.PAYMENTS_UPDATE,
        exports.Permissions.PAYMENTS_CANCEL,
        exports.Permissions.DOCUMENTS_CREATE,
        exports.Permissions.DOCUMENTS_READ,
        exports.Permissions.DOCUMENTS_VERIFY,
        exports.Permissions.CUSTOMERS_KYC_WRITE,
        exports.Permissions.COMPLAINTS_READ,
    ],
    [exports.Roles.MARKETING_DIRECTOR]: [
        exports.Permissions.TASKS_CREATE,
        exports.Permissions.LEADS_CREATE,
        exports.Permissions.LEADS_READ,
        exports.Permissions.LEADS_UPDATE,
        exports.Permissions.LEADS_DELETE,
        exports.Permissions.LEADS_ASSIGN,
        exports.Permissions.LEADS_BULK_UPLOAD,
        exports.Permissions.CUSTOMERS_CREATE,
        exports.Permissions.CUSTOMERS_READ,
        exports.Permissions.CUSTOMERS_UPDATE,
        exports.Permissions.CUSTOMERS_DELETE,
        exports.Permissions.CUSTOMERS_CONVERT,
        exports.Permissions.PROPERTIES_DM_POLISH,
        exports.Permissions.PROPERTIES_MD_APPROVE, // Per Section 8 participation
        exports.Permissions.SITE_VISITS_READ,
        exports.Permissions.REPORTS_TARGETS_CONFIGURE,
        exports.Permissions.REPORTS_READ_TEAM,
        exports.Permissions.PERFORMANCE_READ_TEAM,
        exports.Permissions.BOOKINGS_READ,
        exports.Permissions.PAYMENTS_READ,
        exports.Permissions.DOCUMENTS_CREATE,
        exports.Permissions.DOCUMENTS_READ,
    ],
    [exports.Roles.PROJECT_MANAGER]: [
        exports.Permissions.PROJECTS_CREATE,
        exports.Permissions.PROJECTS_READ,
        exports.Permissions.PROJECTS_UPDATE,
        exports.Permissions.PROJECTS_DELETE,
        exports.Permissions.PROPERTIES_CREATE,
        exports.Permissions.PROPERTIES_VERIFY,
        exports.Permissions.PROPERTIES_READ,
        exports.Permissions.PROPERTIES_UPDATE,
        exports.Permissions.SITE_VISITS_READ,
        exports.Permissions.SITE_VISITS_ASSIGN_AGENT,
        exports.Permissions.TASKS_CREATE,
        exports.Permissions.TASKS_READ,
        exports.Permissions.TASKS_UPDATE,
        exports.Permissions.TASKS_ASSIGN,
        exports.Permissions.LEADS_READ,
        exports.Permissions.CUSTOMERS_READ,
        exports.Permissions.CUSTOMERS_UPDATE,
        exports.Permissions.REPORTS_READ_OWN,
        exports.Permissions.BOOKINGS_READ,
        exports.Permissions.PAYMENTS_READ,
        exports.Permissions.DOCUMENTS_CREATE,
        exports.Permissions.DOCUMENTS_READ,
        exports.Permissions.COMPLAINTS_CREATE,
        exports.Permissions.COMPLAINTS_READ,
        exports.Permissions.COMPLAINTS_UPDATE,
        exports.Permissions.COMPLAINTS_ASSIGN,
        exports.Permissions.COMPLAINTS_RESOLVE,
        exports.Permissions.COMPLAINTS_CLOSE,
    ],
    [exports.Roles.DIGITAL_LEAD_OPERATOR]: [
        exports.Permissions.LEADS_CREATE,
        exports.Permissions.LEADS_READ,
        exports.Permissions.LEADS_UPDATE,
        exports.Permissions.LEADS_ASSIGN,
        exports.Permissions.LEADS_BULK_UPLOAD,
        exports.Permissions.LEADS_DISTRIBUTION_MONITOR,
        exports.Permissions.CUSTOMERS_CREATE,
        exports.Permissions.CUSTOMERS_READ,
        exports.Permissions.CUSTOMERS_UPDATE,
        exports.Permissions.CUSTOMERS_DELETE,
        exports.Permissions.CUSTOMERS_CONVERT,
        exports.Permissions.SITE_VISITS_CREATE,
        exports.Permissions.SITE_VISITS_VERIFY,
        exports.Permissions.REPORTS_TARGETS_CONFIGURE,
        exports.Permissions.BOOKINGS_CREATE,
        exports.Permissions.BOOKINGS_READ,
        exports.Permissions.BOOKINGS_UPDATE,
        exports.Permissions.PAYMENTS_CREATE,
        exports.Permissions.PAYMENTS_READ,
        exports.Permissions.DOCUMENTS_CREATE,
        exports.Permissions.DOCUMENTS_READ,
        exports.Permissions.COMPLAINTS_READ,
        exports.Permissions.COMPLAINTS_UPDATE,
    ],
    [exports.Roles.TELECALLER]: [
        exports.Permissions.PROJECTS_READ,
        exports.Permissions.LEADS_CREATE,
        exports.Permissions.LEADS_READ,
        exports.Permissions.LEADS_UPDATE,
        exports.Permissions.LEADS_WHATSAPP_PROPOSAL,
        exports.Permissions.CUSTOMERS_READ,
        exports.Permissions.CUSTOMERS_UPDATE,
        exports.Permissions.CUSTOMERS_CONVERT,
        exports.Permissions.SITE_VISITS_CREATE,
        exports.Permissions.SITE_VISITS_READ,
        exports.Permissions.TASKS_READ,
        exports.Permissions.TASKS_UPDATE,
        exports.Permissions.ATTENDANCE_READ_OWN,
        exports.Permissions.ATTENDANCE_SCAN,
        exports.Permissions.ATTENDANCE_LATE_PROPOSAL,
        exports.Permissions.ATTENDANCE_LEAVE_PROPOSAL,
        exports.Permissions.REPORTS_CREATE,
        exports.Permissions.REPORTS_READ_OWN,
        exports.Permissions.PERFORMANCE_READ_OWN,
        exports.Permissions.BOOKINGS_READ,
        exports.Permissions.PAYMENTS_READ,
        exports.Permissions.DOCUMENTS_READ,
    ],
    [exports.Roles.DIGITAL_MARKETING_HEAD]: [
        exports.Permissions.PROPERTIES_DM_POLISH,
        exports.Permissions.PROPERTIES_READ,
        exports.Permissions.LEADS_READ,
        exports.Permissions.REPORTS_TARGETS_CONFIGURE,
        exports.Permissions.PERFORMANCE_READ_TEAM,
    ],
    [exports.Roles.AGENT]: [
        exports.Permissions.SITE_VISITS_READ,
        exports.Permissions.SITE_VISITS_COMPLETE,
        exports.Permissions.CUSTOMERS_READ,
        exports.Permissions.CUSTOMERS_UPDATE,
        exports.Permissions.CUSTOMERS_CONVERT,
        exports.Permissions.TASKS_READ,
        exports.Permissions.TASKS_UPDATE,
        exports.Permissions.ATTENDANCE_READ_OWN,
        exports.Permissions.ATTENDANCE_SCAN,
        exports.Permissions.REPORTS_CREATE,
        exports.Permissions.REPORTS_READ_OWN,
        exports.Permissions.PERFORMANCE_READ_OWN,
        exports.Permissions.BOOKINGS_READ,
        exports.Permissions.PAYMENTS_READ,
        exports.Permissions.DOCUMENTS_READ,
        exports.Permissions.COMPLAINTS_CREATE,
        exports.Permissions.COMPLAINTS_READ,
        exports.Permissions.COMPLAINTS_UPDATE,
        exports.Permissions.COMPLAINTS_ASSIGN,
        exports.Permissions.COMPLAINTS_RESOLVE,
        exports.Permissions.COMPLAINTS_CLOSE,
    ],
    [exports.Roles.DIGITAL_MARKETING_EXECUTIVE]: [
        exports.Permissions.LEADS_READ,
        exports.Permissions.LEADS_UPDATE,
        exports.Permissions.SITE_VISITS_READ,
        exports.Permissions.TASKS_READ,
        exports.Permissions.TASKS_UPDATE,
        exports.Permissions.REPORTS_CREATE,
        exports.Permissions.REPORTS_READ_OWN,
        exports.Permissions.ATTENDANCE_READ_OWN,
        exports.Permissions.ATTENDANCE_SCAN,
        exports.Permissions.PERFORMANCE_READ_OWN,
    ],
    [exports.Roles.SALES_MANAGER]: [
        exports.Permissions.TASKS_CREATE,
        exports.Permissions.LEADS_READ,
        exports.Permissions.LEADS_UPDATE,
        exports.Permissions.LEADS_ASSIGN,
        exports.Permissions.LEADS_DISTRIBUTION_MONITOR,
        exports.Permissions.LEADS_WHATSAPP_PROPOSAL,
        exports.Permissions.CUSTOMERS_READ,
        exports.Permissions.CUSTOMERS_UPDATE,
        exports.Permissions.SITE_VISITS_READ,
        exports.Permissions.SITE_VISITS_ASSIGN_AGENT,
        exports.Permissions.TASKS_READ,
        exports.Permissions.TASKS_UPDATE,
        exports.Permissions.TASKS_ASSIGN,
        exports.Permissions.REPORTS_READ_TEAM,
        exports.Permissions.REPORTS_TARGETS_CONFIGURE,
        exports.Permissions.PERFORMANCE_READ_TEAM,
        exports.Permissions.BOOKINGS_READ,
    ],
    [exports.Roles.CHANNEL_PARTNER_MANAGER]: [
        exports.Permissions.LEADS_CREATE,
        exports.Permissions.LEADS_READ,
        exports.Permissions.LEADS_UPDATE,
        exports.Permissions.LEADS_WHATSAPP_PROPOSAL,
        exports.Permissions.PROJECTS_READ,
        exports.Permissions.PROPERTIES_READ,
        exports.Permissions.ATTENDANCE_READ_OWN,
        exports.Permissions.ATTENDANCE_SCAN,
        exports.Permissions.ATTENDANCE_LATE_PROPOSAL,
        exports.Permissions.ATTENDANCE_LEAVE_PROPOSAL,
        exports.Permissions.REPORTS_CREATE,
        exports.Permissions.REPORTS_READ_OWN,
        exports.Permissions.PERFORMANCE_READ_OWN,
        exports.Permissions.TASKS_READ,
        exports.Permissions.TASKS_UPDATE,
        exports.Permissions.TASKS_CREATE,
        exports.Permissions.BOOKINGS_READ,
        exports.Permissions.PAYMENTS_READ,
        exports.Permissions.DOCUMENTS_READ,
        exports.Permissions.SITE_VISITS_CREATE,
        exports.Permissions.SITE_VISITS_READ,
        exports.Permissions.CUSTOMERS_READ,
        exports.Permissions.CUSTOMERS_UPDATE,
        exports.Permissions.CUSTOMERS_CONVERT,
    ]
};
// Employee Code Regex: e.g. RRH-EX-001 (MD), RRH-EX-002 (Admin), RRH-HR-001 (HR), RRH-SL-001 (Sales/Telecaller), DEV-SM-001
exports.EMPLOYEE_CODE_REGEX = /^(RRH|DEV|SON)-[A-Z]{2,5}-\d{3,5}$/;
// Login Request Schema
exports.LoginSchema = zod_1.z.object({
    employee_code: zod_1.z
        .string()
        .trim()
        .toUpperCase()
        .min(1, 'Employee ID is required')
        .regex(exports.EMPLOYEE_CODE_REGEX, 'Invalid Employee ID format. Expected format: RRH-XX-000'),
    password: zod_1.z.string().min(6, 'Password must be at least 6 characters'),
});
// Attendance Status
exports.AttendanceStatus = {
    PRESENT: 'PRESENT',
    LATE: 'LATE',
    APPROVED_LATE: 'APPROVED_LATE',
    HALF_DAY: 'HALF_DAY',
    APPROVED_HALF_DAY: 'APPROVED_HALF_DAY',
    ABSENT: 'ABSENT',
    LEAVE: 'LEAVE',
};
// Password Change Schema (Forced first login)
exports.ChangePasswordSchema = zod_1.z.object({
    current_password: zod_1.z.string().min(1, 'Current password is required'),
    new_password: zod_1.z
        .string()
        .min(8, 'New password must be at least 8 characters')
        .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
        .regex(/[0-9]/, 'Password must contain at least one number'),
});
// Late Proposal Schema (< 09:30 AM IST)
exports.LateProposalSchema = zod_1.z.object({
    date: zod_1.z.string().min(1, 'Date is required'), // YYYY-MM-DD
    expected_time: zod_1.z.string().min(1, 'Expected arrival time is required'), // HH:mm
    reason: zod_1.z.string().min(5, 'Reason must be at least 5 characters'),
});
// Leave Proposal Schema (>= 1 day advance)
exports.LeaveProposalSchema = zod_1.z.object({
    start_date: zod_1.z.string().min(1, 'Start date is required'),
    end_date: zod_1.z.string().min(1, 'End date is required'),
    reason: zod_1.z.string().min(5, 'Reason must be at least 5 characters'),
});
// Task Constants
exports.TaskPriority = {
    LOW: 'LOW',
    MEDIUM: 'MEDIUM',
    HIGH: 'HIGH',
    URGENT: 'URGENT',
};
exports.TaskStatus = {
    PENDING: 'PENDING',
    IN_PROGRESS: 'IN_PROGRESS',
    COMPLETED: 'COMPLETED',
    OVERDUE: 'OVERDUE',
};
// Daily Report Schema (with 15-character minimum below_target_reason check)
exports.DailyReportSchema = zod_1.z.object({
    role_name: zod_1.z.string().min(1),
    metrics: zod_1.z.record(zod_1.z.any()), // Role-specific key-value pairs (e.g. callsMade, siteVisits)
    summary_notes: zod_1.z.string().min(5, 'Summary notes must be at least 5 characters'),
    below_target_reason: zod_1.z
        .string()
        .min(15, 'Reason for missing target must be at least 15 characters long')
        .optional()
        .or(zod_1.z.literal(''))
        .or(zod_1.z.null()),
});
// Daily Target Set Schema (for MD & Marketing Director Target Configurator)
exports.DailyTargetSetSchema = zod_1.z.object({
    role_name: zod_1.z.string().min(1),
    employee_id: zod_1.z.number().int().optional().nullable(),
    target_type: zod_1.z.enum(['COUNT', 'CHECKLIST']),
    targets_json: zod_1.z.record(zod_1.z.any()),
    form_schema_json: zod_1.z.array(zod_1.z.any()).optional(),
    start_date: zod_1.z.string().optional(),
    end_date: zod_1.z.string().optional().nullable(),
});
// Task Create Schema
exports.TaskCreateSchema = zod_1.z.object({
    title: zod_1.z.string().min(3, 'Title must be at least 3 characters'),
    description: zod_1.z.string().optional(),
    assignee_id: zod_1.z.number().int().positive(),
    priority: zod_1.z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).default('MEDIUM'),
    deadline: zod_1.z.string().min(1, 'Deadline date/time is required'),
    lead_id: zod_1.z.number().int().positive().optional().nullable(),
    opportunity_id: zod_1.z.number().int().positive().optional().nullable(),
    booking_id: zod_1.z.number().int().positive().optional().nullable(),
});
// Task Status Update Schema
exports.TaskUpdateStatusSchema = zod_1.z.object({
    status: zod_1.z.enum(['PENDING', 'IN_PROGRESS', 'COMPLETED', 'OVERDUE']),
});
// Lead Constants & Schemas
exports.LeadStatus = {
    NEW: 'NEW',
    ASSIGNED: 'ASSIGNED',
    CONTACTED: 'CONTACTED',
    QUALIFICATION_PENDING: 'QUALIFICATION_PENDING',
    QUALIFIED: 'QUALIFIED',
    DEMO_SCHEDULED: 'DEMO_SCHEDULED',
    DEMO_COMPLETED: 'DEMO_COMPLETED',
    SITE_VISIT_SCHEDULED: 'SITE_VISIT_SCHEDULED',
    SITE_VISIT_COMPLETED: 'SITE_VISIT_COMPLETED',
    NEGOTIATION: 'NEGOTIATION',
    BOOKING_INITIATED: 'BOOKING_INITIATED',
    BOOKED: 'BOOKED',
    DROPPED: 'DROPPED',
    RECOVERED_TO_POOL: 'RECOVERED_TO_POOL',
};
exports.LeadSource = {
    MANUAL_ENTRY: 'MANUAL_ENTRY',
    BULK_UPLOAD: 'BULK_UPLOAD',
    WEBSITE: 'WEBSITE',
    FACEBOOK_ADS: 'FACEBOOK_ADS',
    GOOGLE_ADS: 'GOOGLE_ADS',
    WALK_IN: 'WALK_IN',
    REFERRAL: 'REFERRAL',
    HOUSING_COM: 'HOUSING_COM',
};
exports.LeadCreateSchema = zod_1.z.object({
    customer_name: zod_1.z.string().min(2, 'Customer name is required'),
    phone: zod_1.z.string().min(10, 'Valid phone number is required'),
    email: zod_1.z.string().email('Invalid email address').optional().or(zod_1.z.literal('')),
    source: zod_1.z.string().default('MANUAL_ENTRY'),
    property_type_preference: zod_1.z.string().optional(),
    budget_min: zod_1.z.number().optional().nullable(),
    budget_max: zod_1.z.number().optional().nullable(),
    preferred_location: zod_1.z.string().optional(),
    notes: zod_1.z.string().optional(),
    campaign: zod_1.z.string().optional().nullable(),
    utm_source: zod_1.z.string().optional().nullable(),
    utm_medium: zod_1.z.string().optional().nullable(),
    utm_campaign: zod_1.z.string().optional().nullable(),
    referral_person_name: zod_1.z.string().optional().nullable(),
    referral_employee_id: zod_1.z.number().optional().nullable(),
});
// Website public lead intake — mirrors the fields the public API currently accepts.
// Intentionally narrower than the internal LeadCreateSchema (no source/campaign/UTM:
// source is forced to WEBSITE server-side).
exports.PublicLeadCreateSchema = zod_1.z.object({
    customer_name: zod_1.z.string().min(2, 'Customer name is required'),
    phone: zod_1.z.string().min(10, 'Valid phone number is required'),
    email: zod_1.z.string().email('Invalid email address').optional().or(zod_1.z.literal('')),
    property_type_preference: zod_1.z.string().optional(),
    preferred_location: zod_1.z.string().optional(),
    enquiry_type: zod_1.z.enum(['appraisal', 'call', 'project', 'property', 'consultation', 'other']).optional(),
    preferred_contact_time: zod_1.z.enum(['immediate', 'business_hours', 'after_hours', 'anytime']).optional(),
    property_ids: zod_1.z.array(zod_1.z.number().int().positive()).max(10).optional(),
    project_id: zod_1.z.number().int().positive().optional().nullable(),
    budget_max: zod_1.z.number().positive('Budget must be a positive number').optional().nullable(),
    notes: zod_1.z.string().optional(),
});
exports.LeadStatusUpdateSchema = zod_1.z.object({
    status: zod_1.z.enum([
        'NEW',
        'ASSIGNED',
        'CONTACTED',
        'QUALIFICATION_PENDING',
        'QUALIFIED',
        'DEMO_SCHEDULED',
        'DEMO_COMPLETED',
        'SITE_VISIT_SCHEDULED',
        'SITE_VISIT_COMPLETED',
        'NEGOTIATION',
        'BOOKING_INITIATED',
        'BOOKED',
        'DROPPED',
        'RECOVERED_TO_POOL',
    ]),
    notes: zod_1.z.string().optional(),
    // §1 guard fields — required for specific transitions (enforced in service)
    exit_reason: zod_1.z.string().optional(), // required when status -> DROPPED
    demo_scheduled_at: zod_1.z.string().datetime().optional(), // required when status -> DEMO_SCHEDULED
    demo_handler_id: zod_1.z.number().int().positive().optional(), // required when status -> DEMO_SCHEDULED
    qualification: zod_1.z.object({
        budget_min: zod_1.z.number().nonnegative().optional(),
        budget_max: zod_1.z.number().nonnegative().optional(),
        property_type_preference: zod_1.z.string().optional(),
        preferred_location: zod_1.z.string().optional(),
    }).partial().optional(),
});
exports.LeadReassignSchema = zod_1.z.object({
    assigned_to_id: zod_1.z.number().int().positive('Assignee ID is required'),
    reason: zod_1.z.string().min(3, 'Reassignment reason is required'),
});
// Project Constants & Schemas
exports.ProjectCreateSchema = zod_1.z.object({
    name: zod_1.z.string().min(3),
    description: zod_1.z.string().optional(),
    location: zod_1.z.string().min(3),
    total_area: zod_1.z.string().optional(),
    launch_date: zod_1.z.string().optional(),
    amenities: zod_1.z.any().optional(),
    assigned_pm_id: zod_1.z.number().int().positive().optional().nullable(),
});
exports.ProjectUpdateSchema = zod_1.z.object({
    name: zod_1.z.string().min(3).optional(),
    description: zod_1.z.string().optional(),
    location: zod_1.z.string().min(3).optional(),
    total_area: zod_1.z.string().optional(),
    launch_date: zod_1.z.string().optional(),
    amenities: zod_1.z.any().optional(),
    assigned_pm_id: zod_1.z.number().int().positive().optional().nullable(),
    status: zod_1.z.enum(['PLANNING', 'UNDER_CONSTRUCTION', 'COMPLETED', 'CANCELLED']).optional(),
});
exports.AddPropertyInterestSchema = zod_1.z.object({
    property_id: zod_1.z.number().int().positive(),
});
// Property Constants & Schemas
exports.PropertyStatus = {
    PENDING_VERIFICATION: 'PENDING_VERIFICATION',
    PENDING_DM_POLISH: 'PENDING_DM_POLISH',
    PENDING_MD_APPROVAL: 'PENDING_MD_APPROVAL',
    LIVE: 'LIVE',
    REJECTED: 'REJECTED',
    LOCKED: 'LOCKED',
    BOOKED: 'BOOKED',
    SOLD: 'SOLD',
};
exports.PropertyAvailability = {
    AVAILABLE: 'AVAILABLE',
    RESERVED: 'RESERVED',
    SOLD: 'SOLD',
    UNAVAILABLE: 'UNAVAILABLE',
};
exports.PropertyBrand = {
    SONTHILLU: 'SONTHILLU', // Residential Villas & Apartments
    RADHA_REAL_HOMES: 'RADHA_REAL_HOMES', // Commercial Plots & Land
};
exports.PropertyCreateSchema = zod_1.z.object({
    title: zod_1.z.string().min(3, 'Title is required'),
    description: zod_1.z.string().optional(),
    brand_type: zod_1.z.enum(['SONTHILLU', 'RADHA_REAL_HOMES']),
    category: zod_1.z.enum([
        'APARTMENT', 'INDEPENDENT_HOUSE', 'DUPLEX', 'INDEPENDENT_FLOOR',
        'VILLA', 'PENTHOUSE', 'STUDIO', 'PLOT', 'FARM_HOUSE', 'AGRICULTURAL_LAND'
    ]),
    price: zod_1.z.number().positive('Price must be greater than 0'),
    area_sqft: zod_1.z.number().positive('Area in sqft is required'),
    location: zod_1.z.string().min(2, 'Location is required'),
    address: zod_1.z.string().optional(),
    bedrooms: zod_1.z.number().int().optional().nullable(),
    bathrooms: zod_1.z.number().int().optional().nullable(),
    facing: zod_1.z.string().optional(),
    amenities: zod_1.z.string().optional(),
    possession_status: zod_1.z.enum(['READY_TO_MOVE', 'UNDER_CONSTRUCTION']).optional(),
    assigned_pm_id: zod_1.z.number().int().optional().nullable(),
    details: zod_1.z.any().optional(),
    // WR-2: Structured location fields
    state: zod_1.z.string().optional().nullable(),
    city: zod_1.z.string().optional().nullable(),
    locality: zod_1.z.string().optional().nullable(),
    pincode: zod_1.z.string().optional().nullable(),
    latitude: zod_1.z.number().optional().nullable(),
    longitude: zod_1.z.number().optional().nullable(),
    listing_type: zod_1.z.enum(['NEW', 'RESALE']).optional(),
    source: zod_1.z.enum(['INTERNAL', 'WEBSITE_SELLER']).optional(),
});
exports.PropertyVerificationSchema = zod_1.z.object({
    approved: zod_1.z.boolean(),
    notes: zod_1.z.string().min(3, 'Verification notes required'),
    assigned_pm_id: zod_1.z.number().int().optional(),
});
exports.PropertyDMUpdateSchema = zod_1.z.object({
    digital_marketing_executive_id: zod_1.z.number().int().positive('Must select a Digital Marketing Executive'),
    seo_title: zod_1.z.string().optional(),
    seo_keywords: zod_1.z.string().optional(),
    description: zod_1.z.string().optional(),
    notes: zod_1.z.string().optional(),
});
exports.PropertyDMVerifyAsIsSchema = zod_1.z.object({
    notes: zod_1.z.string().optional(),
});
exports.PropertyMDApprovalSchema = zod_1.z.object({
    approved: zod_1.z.boolean(),
    comments: zod_1.z.string().optional(),
});
exports.PropertyUpdateSchema = zod_1.z.object({
    title: zod_1.z.string().min(3).optional(),
    description: zod_1.z.string().optional(),
    type: zod_1.z.enum(['APARTMENT', 'VILLA', 'PLOT', 'COMMERCIAL']).optional(),
    price: zod_1.z.number().positive().optional(),
    size: zod_1.z.string().optional(),
    location: zod_1.z.string().min(3).optional(),
    bhk: zod_1.z.number().int().positive().optional(),
    facing: zod_1.z.string().optional(),
    amenities: zod_1.z.any().optional(),
    project_id: zod_1.z.number().int().positive().nullable().optional(),
    status: zod_1.z.enum(['PENDING_VERIFICATION', 'PENDING_DM_POLISH', 'PENDING_MD_APPROVAL', 'LIVE', 'REJECTED', 'LOCKED', 'BOOKED', 'SOLD']).optional(),
    // WR-2: Structured location fields
    state: zod_1.z.string().optional().nullable(),
    city: zod_1.z.string().optional().nullable(),
    locality: zod_1.z.string().optional().nullable(),
    pincode: zod_1.z.string().optional().nullable(),
    latitude: zod_1.z.number().optional().nullable(),
    longitude: zod_1.z.number().optional().nullable(),
    listing_type: zod_1.z.enum(['NEW', 'RESALE']).optional(),
});
exports.PropertyPublicationSchema = zod_1.z.object({
    property_id: zod_1.z.number().int().positive(),
    company_id: zod_1.z.number().int().positive(),
    is_published: zod_1.z.boolean(),
});
// Expense Refund Constants & Schemas
exports.ExpenseRefundStatus = {
    PENDING: 'PENDING',
    ACCOUNTANT_APPROVED: 'ACCOUNTANT_APPROVED',
    MD_APPROVED: 'MD_APPROVED',
    REFUNDED: 'REFUNDED',
    REJECTED_BY_ACCOUNTANT: 'REJECTED_BY_ACCOUNTANT',
    REJECTED_BY_MD: 'REJECTED_BY_MD',
};
exports.ExpenseRefundCreateSchema = zod_1.z.object({
    purpose: zod_1.z.string().min(3, 'Purpose is required'),
    amount: zod_1.z.number().positive('Amount must be greater than 0'),
});
exports.ExpenseRefundAccountantReviewSchema = zod_1.z.object({
    decision: zod_1.z.enum(['APPROVE', 'REJECT']),
    note: zod_1.z.string().optional(),
});
exports.ExpenseRefundMDReviewSchema = zod_1.z.object({
    decision: zod_1.z.enum(['APPROVE', 'REJECT']),
    note: zod_1.z.string().optional(),
});
exports.ExpenseRefundMarkRefundedSchema = zod_1.z.object({});
// ─────────────────────────────────────────────────────────────
// CUSTOMER SCHEMAS
// ─────────────────────────────────────────────────────────────
exports.CustomerCreateSchema = zod_1.z.object({
    first_name: zod_1.z.string().min(2),
    last_name: zod_1.z.string().optional(),
    phone: zod_1.z.string().min(10),
    email: zod_1.z.string().email().optional(),
    status: zod_1.z.string().default('ACTIVE'),
    source: zod_1.z.string().default('MANUAL_ENTRY'),
    assigned_to_id: zod_1.z.number().optional(),
});
exports.CustomerUpdateSchema = zod_1.z.object({
    first_name: zod_1.z.string().min(2).optional(),
    last_name: zod_1.z.string().optional(),
    phone: zod_1.z.string().min(10).optional(),
    email: zod_1.z.string().email().optional(),
    status: zod_1.z.string().optional(),
});
// ─────────────────────────────────────────────────────────────
// DOCUMENT MANAGEMENT — Phase 11
// ─────────────────────────────────────────────────────────────
exports.DocumentType = {
    KYC_PAN: 'KYC_PAN',
    KYC_AADHAAR: 'KYC_AADHAAR',
    BOOKING_AGREEMENT: 'BOOKING_AGREEMENT',
    PAYMENT_RECEIPT: 'PAYMENT_RECEIPT',
    BOOKING_RECEIPT: 'BOOKING_RECEIPT',
    SALE_DEED: 'SALE_DEED',
    PROPERTY_TITLE: 'PROPERTY_TITLE',
    PROPERTY_PLAN: 'PROPERTY_PLAN',
    PROPOSAL: 'PROPOSAL',
    OTHER: 'OTHER',
};
exports.DocumentStatus = {
    ACTIVE: 'ACTIVE',
    ARCHIVED: 'ARCHIVED',
};
exports.DocumentVerificationStatus = {
    PENDING: 'PENDING',
    VERIFIED: 'VERIFIED',
    REJECTED: 'REJECTED',
};
// Document type -> required entity FK mapping
exports.DOCUMENT_TYPE_ENTITY_REQUIREMENTS = {
    [exports.DocumentType.KYC_PAN]: { required: ['customer_id'], optional: [] },
    [exports.DocumentType.KYC_AADHAAR]: { required: ['customer_id'], optional: [] },
    [exports.DocumentType.BOOKING_AGREEMENT]: { required: ['booking_id'], optional: ['customer_id'] },
    [exports.DocumentType.BOOKING_RECEIPT]: { required: ['booking_id'], optional: ['payment_id'] },
    [exports.DocumentType.PAYMENT_RECEIPT]: { required: ['payment_id'], optional: ['booking_id'] },
    [exports.DocumentType.SALE_DEED]: { required: ['booking_id'], optional: ['property_id', 'customer_id'] },
    [exports.DocumentType.PROPERTY_TITLE]: { required: ['property_id'], optional: ['project_id'] },
    [exports.DocumentType.PROPERTY_PLAN]: { required: ['property_id'], optional: ['project_id'] },
    [exports.DocumentType.PROPOSAL]: { required: ['lead_id'], optional: ['opportunity_id'] },
    [exports.DocumentType.OTHER]: { required: [], optional: ['customer_id', 'lead_id', 'opportunity_id', 'booking_id', 'property_id', 'project_id', 'payment_id'] },
};
exports.DocumentUploadSchema = zod_1.z.object({
    document_type: zod_1.z.enum([
        'KYC_PAN', 'KYC_AADHAAR', 'BOOKING_AGREEMENT', 'PAYMENT_RECEIPT',
        'BOOKING_RECEIPT', 'SALE_DEED', 'PROPERTY_TITLE', 'PROPERTY_PLAN',
        'PROPOSAL', 'OTHER',
    ]),
    title: zod_1.z.string().min(1, 'Title is required').max(255),
    customer_id: zod_1.z.coerce.number().int().positive().optional().nullable(),
    lead_id: zod_1.z.coerce.number().int().positive().optional().nullable(),
    opportunity_id: zod_1.z.coerce.number().int().positive().optional().nullable(),
    booking_id: zod_1.z.coerce.number().int().positive().optional().nullable(),
    property_id: zod_1.z.coerce.number().int().positive().optional().nullable(),
    project_id: zod_1.z.coerce.number().int().positive().optional().nullable(),
    payment_id: zod_1.z.coerce.number().int().positive().optional().nullable(),
    notes: zod_1.z.string().optional().nullable(),
});
exports.DocumentVerifySchema = zod_1.z.object({
    status: zod_1.z.enum(['VERIFIED', 'REJECTED']),
    notes: zod_1.z.string().optional().nullable(),
});
exports.DocumentArchiveSchema = zod_1.z.object({
    reason: zod_1.z.string().optional().nullable(),
});
// ─────────────────────────────────────────────────────────────
// CUSTOMER PORTAL INTEGRATION — Phase 11 Packet 3B
// ─────────────────────────────────────────────────────────────
exports.PortalCallbackStatus = {
    COMPLETED: 'completed',
    FAILED: 'failed',
};
exports.PortalCallbackSchema = zod_1.z.object({
    idempotency_key: zod_1.z.string().min(1),
    event_type: zod_1.z.literal('BOOKING_PORTAL_HANDOFF'),
    status: zod_1.z.enum(['completed', 'failed']),
    portal_customer_id: zod_1.z.string().optional().nullable(),
    portal_booking_id: zod_1.z.string().optional().nullable(),
    company_id: zod_1.z.number().int().positive(),
    crms_booking_id: zod_1.z.number().int().positive(),
    message: zod_1.z.string().optional().nullable(),
});
// ─────────────────────────────────────────────────────────────
// CUSTOMER KYC — Phase 11 Packet 3C (KYC Data Bridge)
// ─────────────────────────────────────────────────────────────
exports.KycStatus = {
    PENDING: 'PENDING',
    PARTIAL: 'PARTIAL',
    VERIFIED: 'VERIFIED',
    REJECTED: 'REJECTED',
};
exports.KYC_STATUSES = Object.values(exports.KycStatus);
/**
 * CRM-internal KYC write/update path. Encrypted at rest before persistence.
 * Raw PAN/Aadhaar NEVER cross the CRM ↔ Portal boundary (Packet 3C §3.4).
 */
exports.CustomerKycWriteSchema = zod_1.z.object({
    pan_number: zod_1.z.string().regex(/^[A-Z0-9]{10}$/, 'PAN must be 10 alphanumeric characters').optional(),
    aadhaar_number: zod_1.z.string().regex(/^\d{12}$/, 'Aadhaar must be 12 digits').optional(),
});
/**
 * Outbound CRM → Portal KYC status push payload (Packet 3C §3).
 * Contains ONLY status + masked PAN — never raw PAN/Aadhaar/bank data.
 */
exports.KycStatusChangedSchema = zod_1.z.object({
    event_type: zod_1.z.literal('CUSTOMER_KYC_STATUS_CHANGED'),
    company_id: zod_1.z.number().int().positive(),
    crms_customer_id: zod_1.z.number().int().positive(),
    crms_booking_id: zod_1.z.number().int().positive().nullable(),
    kyc_status: zod_1.z.enum(['PENDING', 'PARTIAL', 'VERIFIED', 'REJECTED']),
    masked_pan: zod_1.z.string().nullable(),
    verified_at: zod_1.z.string().datetime().nullable(),
});
// ─────────────────────────────────────────────────────────────
// PORTAL → CRM KYC SUBMISSION CALLBACK — Phase 11 Packet 3D
// ─────────────────────────────────────────────────────────────
/**
 * Inbound Portal → CRM KYC submission callback (Packet 3D).
 * The Portal may report ONLY "submitted" — verification authority stays
 * exclusively in CRM. Raw PAN/Aadhaar/bank/document data is NEVER part of
 * this contract (Packet 3C §3.4 / §4.2).
 */
exports.KycCallbackSchema = zod_1.z.object({
    idempotency_key: zod_1.z.string().min(1),
    event_type: zod_1.z.literal('CUSTOMER_KYC_STATUS_CHANGED'),
    status: zod_1.z.literal('submitted'),
    portal_customer_id: zod_1.z.string().optional().nullable(),
    company_id: zod_1.z.number().int().positive(),
    crms_customer_id: zod_1.z.number().int().positive(),
    crms_booking_id: zod_1.z.number().int().positive().optional().nullable(),
}).strict();
// ─────────────────────────────────────────────────────────────
// PAYMENT SYNCHRONIZATION — Phase 11 Packet 3F
// ─────────────────────────────────────────────────────────────
exports.PAYMENT_EVENT_TYPE = 'PAYMENT_STATUS_CHANGED';
/**
 * Outbound CRM → Portal payment status push payload (Packet 3F §4).
 * Contains ONLY amounts + identifiers — NEVER card/UPI/bank credentials,
 * CVV, or any raw financial secret (3A–3E sensitive-data policy).
 */
exports.PaymentStatusChangedSchema = zod_1.z.object({
    event_type: zod_1.z.literal(exports.PAYMENT_EVENT_TYPE),
    company_id: zod_1.z.number().int().positive(),
    crms_customer_id: zod_1.z.number().int().positive(),
    crms_booking_id: zod_1.z.number().int().positive(),
    payment_id: zod_1.z.number().int().positive(),
    payment_code: zod_1.z.string().min(1),
    installment_id: zod_1.z.number().int().positive().nullable(),
    amount: zod_1.z.number().positive(),
    status: zod_1.z.enum(['SUCCESS', 'REFUNDED']),
    payment_date: zod_1.z.string().datetime(),
    reference_number: zod_1.z.string().nullable().optional(),
});
/**
 * Inbound Portal → CRM payment callback (Packet 3F §5).
 * The Portal may report ONLY "completed" / "failed" — it may never claim
 * SUCCESS/REFUNDED (CRM owns verification, enforced at the schema boundary).
 * References the outbound PAYMENT_STATUS_CHANGED IntegrationEvent via its
 * idempotency key; it NEVER creates a new IntegrationEvent.
 */
exports.PaymentCallbackSchema = zod_1.z.object({
    idempotency_key: zod_1.z.string().min(1),
    event_type: zod_1.z.literal(exports.PAYMENT_EVENT_TYPE),
    status: zod_1.z.enum(['completed', 'failed']),
    company_id: zod_1.z.number().int().positive(),
    crms_customer_id: zod_1.z.number().int().positive(),
    crms_booking_id: zod_1.z.number().int().positive(),
    payment_id: zod_1.z.number().int().positive(),
    portal_payment_id: zod_1.z.string().optional().nullable(),
    message: zod_1.z.string().optional().nullable(),
}).strict();
// ─────────────────────────────────────────────────────────────
// INSTALLMENT / FINANCIAL STATUS SYNC — Phase 11 Packet 3H
// ─────────────────────────────────────────────────────────────
exports.INSTALLMENT_EVENT_TYPE = 'INSTALLMENT_STATUS_CHANGED';
/**
 * Outbound CRM → Portal installment financial status push (Packet 3H §5).
 *
 * Emitted atomically inside verifyPayment's transaction whenever an
 * installment's PERSISTED status genuinely transitions (PENDING →
 * PARTIALLY_RECEIVED / RECEIVED, PARTIALLY_RECEIVED → RECEIVED). OVERDUE is
 * read-derived in the CRM (lazy, never persisted) and therefore is never
 * emitted here.
 *
 * Contains ONLY identifiers + amounts + status — NEVER PAN/Aadhaar, bank
 * data, salary, credentials, or secrets (3A–3G sensitive-data policy).
 * remaining_amount = expected_amount - received_amount is the Portal's
 * derived outstanding figure. CRM remains the financial source of truth.
 */
exports.InstallmentStatusChangedSchema = zod_1.z.object({
    event_type: zod_1.z.literal(exports.INSTALLMENT_EVENT_TYPE),
    company_id: zod_1.z.number().int().positive(),
    crms_customer_id: zod_1.z.number().int().positive(),
    crms_booking_id: zod_1.z.number().int().positive(),
    installment_id: zod_1.z.number().int().positive(),
    installment_number: zod_1.z.number().int().positive(),
    status: zod_1.z.enum(['PENDING', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED']),
    expected_amount: zod_1.z.number().positive(),
    received_amount: zod_1.z.number().nonnegative(),
    remaining_amount: zod_1.z.number().nonnegative(),
    changed_at: zod_1.z.string().datetime(),
});
// ─────────────────────────────────────────────────────────────
// CUSTOMER NOTIFICATIONS — Phase 11 Packet 3E
// ─────────────────────────────────────────────────────────────
exports.CustomerNotificationType = {
    PORTAL_ACTIVATED: 'PORTAL_ACTIVATED',
    KYC_STATUS_UPDATED: 'KYC_STATUS_UPDATED',
    PAYMENT_STATUS_UPDATED: 'PAYMENT_STATUS_UPDATED', // Phase 11 Packet 3F
};
/**
 * Read-only query for the Portal-facing customer-notifications API (Packet 3E).
 * The Portal may only READ; it can never create/update/delete notifications.
 * company_id + crms_customer_id are tenant/customer-scoped (both required).
 */
exports.CustomerNotificationReadSchema = zod_1.z.object({
    company_id: zod_1.z.number().int().positive(),
    crms_customer_id: zod_1.z.number().int().positive(),
    page: zod_1.z.number().int().positive().default(1),
    limit: zod_1.z.number().int().positive().max(100).default(20),
}).strict();
/**
 * Single customer-notification item returned by the read API (Packet 3E).
 * Carries ONLY low-sensitivity fields — never raw PAN/Aadhaar/bank/salary.
 */
exports.CustomerNotificationResponseSchema = zod_1.z.object({
    id: zod_1.z.number().int().positive(),
    type: zod_1.z.string().min(1),
    title: zod_1.z.string().min(1),
    message: zod_1.z.string().min(1),
    is_read: zod_1.z.boolean(),
    booking_id: zod_1.z.number().int().positive().nullable(),
    created_at: zod_1.z.string().datetime(),
}).strict();
// ─────────────────────────────────────────────────────────────
// PORTAL / INTEGRATION METRICS — Phase 11 Packet 3G
// ─────────────────────────────────────────────────────────────
/**
 * Read-only metrics query for GET /api/v1/integration/metrics (Packet 3G).
 *
 * - from/to are IST calendar dates (YYYY-MM-DD). Without them, the metrics
 *   snapshot covers the full company history; with them, only rows created
 *   inside the IST date range are counted.
 * - includeTimeseries=true requires both from and to (time-series over an
 *   unbounded window is not meaningful). It adds daily IST buckets.
 * - Authenticated via a user JWT + ADMIN_SYSTEM_METRICS — NEVER the Portal
 *   service token (the Portal must not read cross-tenant aggregate data).
 */
exports.IntegrationMetricsQuerySchema = zod_1.z.object({
    from: zod_1.z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'from must be YYYY-MM-DD (IST)').optional(),
    to: zod_1.z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'to must be YYYY-MM-DD (IST)').optional(),
    includeTimeseries: zod_1.z.enum(['true', 'false']).optional(),
}).strict();
/**
 * Response shape for the metrics endpoint. Aggregates ONLY — no raw
 * IntegrationEvent payloads, PAN/Aadhaar, bank data, or other sensitive
 * information ever crosses this contract (3A–3G sensitive-data policy).
 */
exports.IntegrationMetricsResponseSchema = zod_1.z.object({
    generated_at: zod_1.z.string().datetime(),
    company_id: zod_1.z.number().int().positive(),
    range: zod_1.z.object({
        from: zod_1.z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
        to: zod_1.z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    }),
    handoffs: zod_1.z.object({
        total: zod_1.z.number().int().nonnegative(),
        byStatus: zod_1.z.record(zod_1.z.number().int().nonnegative()),
        activationRate: zod_1.z.number().min(0).max(100).nullable(),
    }),
    outbox: zod_1.z.object({
        total: zod_1.z.number().int().nonnegative(),
        byEventType: zod_1.z.record(zod_1.z.number().int().nonnegative()),
        byStatus: zod_1.z.record(zod_1.z.number().int().nonnegative()),
        retried: zod_1.z.number().int().nonnegative(),
        terminalFailures: zod_1.z.number().int().nonnegative(),
    }),
    payments: zod_1.z.object({
        total: zod_1.z.number().int().nonnegative(),
        bySyncStatus: zod_1.z.record(zod_1.z.number().int().nonnegative()),
        bySource: zod_1.z.record(zod_1.z.number().int().nonnegative()),
    }),
    kyc: zod_1.z.object({
        total: zod_1.z.number().int().nonnegative(),
        byStatus: zod_1.z.record(zod_1.z.number().int().nonnegative()),
        submissions: zod_1.z.number().int().nonnegative(),
    }),
    notifications: zod_1.z.object({
        total: zod_1.z.number().int().nonnegative(),
        byType: zod_1.z.record(zod_1.z.number().int().nonnegative()),
    }),
    timeseries: zod_1.z.object({
        days: zod_1.z.array(zod_1.z.record(zod_1.z.any())),
    }).optional(),
}).strict();
// Opportunity Schemas
exports.OpportunityCreateSchema = zod_1.z.object({
    lead_id: zod_1.z.number().int().positive(),
    owner_id: zod_1.z.number().int().positive().optional(),
    project_id: zod_1.z.number().int().positive().optional(),
    property_id: zod_1.z.number().int().positive().optional(),
    expected_value: zod_1.z.number().nonnegative().optional(),
    probability: zod_1.z.number().min(0).max(100).optional(),
    budget_min: zod_1.z.number().nonnegative().optional(),
    budget_max: zod_1.z.number().nonnegative().optional(),
});
exports.OpportunityUpdateSchema = zod_1.z.object({
    expected_value: zod_1.z.number().nonnegative().optional(),
    probability: zod_1.z.number().min(0).max(100).optional(),
    stage: zod_1.z.string().optional(),
    drop_reason: zod_1.z.string().optional(),
    budget_min: zod_1.z.number().nonnegative().optional(),
    budget_max: zod_1.z.number().nonnegative().optional(),
    property_id: zod_1.z.number().int().positive().optional(),
});
// ─────────────────────────────────────────────────────────────
// Site Visit Schemas (§2 Site Visit Sub-Workflow)
// ─────────────────────────────────────────────────────────────
// Full §2 SiteVisitBooking.status state list
exports.SiteVisitStatus = {
    REQUESTED: 'REQUESTED',
    PENDING_ACCEPTANCE: 'PENDING_ACCEPTANCE',
    REASSIGNED: 'REASSIGNED',
    ESCALATED_TO_MARKETING_DIRECTOR: 'ESCALATED_TO_MARKETING_DIRECTOR',
    ACCEPTED: 'ACCEPTED',
    PENDING_CUSTOMER_RECONFIRMATION: 'PENDING_CUSTOMER_RECONFIRMATION',
    RESCHEDULE_REQUESTED: 'RESCHEDULE_REQUESTED',
    PENDING_PM_RECONFIRMATION: 'PENDING_PM_RECONFIRMATION',
    CONFIRMED: 'CONFIRMED',
    ACTIVE: 'ACTIVE',
    COMPLETED: 'COMPLETED',
    CANCELLED: 'CANCELLED',
};
exports.SiteVisitOutcome = {
    INTERESTED: 'INTERESTED',
    NOT_INTERESTED: 'NOT_INTERESTED',
};
exports.SiteVisitCreateSchema = zod_1.z.object({
    lead_id: zod_1.z.number().int().positive(),
    // §2: all properties in a single booking must belong to the same project.
    property_ids: zod_1.z.array(zod_1.z.number().int().positive()).min(1).optional(),
    project_id: zod_1.z.number().int().positive().optional(),
    scheduled_date: zod_1.z.string().datetime(),
    opportunity_id: zod_1.z.number().int().positive().optional(),
    pick_up_requested: zod_1.z.boolean().optional().default(false),
    pick_up_address: zod_1.z.string().optional(),
});
// Accept (PM/Agent accepts the routed visit)
exports.SiteVisitAcceptSchema = zod_1.z.object({
    notes: zod_1.z.string().optional(),
});
// Reassign (open chain during initial acceptance) — reason required
exports.SiteVisitReassignSchema = zod_1.z.object({
    to_employee_id: zod_1.z.number().int().positive(),
    reason: zod_1.z.string().min(3, 'Reassignment reason is required'),
});
// Escalate to Marketing Director (no PM/Agent left to try)
exports.SiteVisitEscalateSchema = zod_1.z.object({
    reason: zod_1.z.string().min(3, 'Escalation reason is required'),
});
// Reschedule (customer requested a date/property change) or release
exports.SiteVisitRescheduleSchema = zod_1.z.object({
    scheduled_date: zod_1.z.string().datetime().optional(),
    property_ids: zod_1.z.array(zod_1.z.number().int().positive()).min(1).optional(),
});
// Confirm PM reconfirmation after a reschedule (or release back to open chain)
exports.SiteVisitReconfirmSchema = zod_1.z.object({
    release: zod_1.z.boolean().optional().default(false),
});
// Complete — one outcome row per linked property (outcome_reason required if NOT_INTERESTED)
exports.SiteVisitOutcomeSchema = zod_1.z.object({
    property_id: zod_1.z.number().int().positive(),
    outcome: zod_1.z.enum(['INTERESTED', 'NOT_INTERESTED']),
    outcome_reason: zod_1.z.string().optional(),
});
exports.SiteVisitCompleteSchema = zod_1.z.object({
    outcomes: zod_1.z.array(exports.SiteVisitOutcomeSchema).min(1),
    feedback_notes: zod_1.z.string().optional(),
    proof_photo_url: zod_1.z.string().optional(),
});
// Generic update (used by older/aux endpoints; status is free-form here but
// routed through the §2 workflow engine in the service layer).
exports.SiteVisitUpdateSchema = zod_1.z.object({
    scheduled_date: zod_1.z.string().datetime().optional(),
    status: zod_1.z.string().optional(),
    notes: zod_1.z.string().optional(),
    confirmed: zod_1.z.boolean().optional(),
    verification_notes: zod_1.z.string().optional(),
    agent_id: zod_1.z.number().int().positive().optional(),
    rating: zod_1.z.string().optional(),
    feedback_notes: zod_1.z.string().optional(),
    proof_photo_url: zod_1.z.string().optional(),
});
// ─────────────────────────────────────────────────────────────
// Message Template Schema (§5)
// ─────────────────────────────────────────────────────────────
exports.MessageTemplateSchema = zod_1.z.object({
    template_key: zod_1.z.string().min(2).max(191),
    name: zod_1.z.string().min(1).max(191),
    body_text: zod_1.z.string().min(1),
    is_active: zod_1.z.boolean().optional().default(true),
});
// §5 — stable template_key values for the WhatsApp deep-link touchpoints.
// These are the canonical lookup keys used by resolveTemplate() and by the
// admin template editor. The body_text of each supports the placeholders
// {customer_name}, {property_name}, {pm_name}, {visit_date}.
exports.MessageTemplateKey = {
    LEAD_QUALIFIED_PROPERTIES: 'LEAD_QUALIFIED_PROPERTIES', // legacy/alias
    LEAD_PROPERTY_PROPOSAL: 'LEAD_PROPERTY_PROPOSAL', // matched property list + invite to discuss
    DEMO_SCHEDULED: 'DEMO_SCHEDULED', // confirm demo date/time
    SITE_VISIT_SCHEDULED: 'SITE_VISIT_SCHEDULED', // schedule confirmation
    SITE_VISIT_ACCEPTED: 'SITE_VISIT_ACCEPTED', // attending PM/Agent name, phone, property, date/time
    DAY_BEFORE_RECONFIRMATION: 'DAY_BEFORE_RECONFIRMATION', // "confirming your visit tomorrow at X"
    RESCHEDULE_CONFIRMED: 'RESCHEDULE_CONFIRMED', // new date/time confirmation
    POST_VISIT_INTERESTED: 'POST_VISIT_INTERESTED', // thank-you + next steps toward booking
    BOOKING_CONFIRMED: 'BOOKING_CONFIRMED', // welcome + portal credentials
};
exports.PropertyTogglePublicationBodySchema = zod_1.z.object({
    company_id: zod_1.z.number().int().positive(),
    is_published: zod_1.z.boolean(),
});
exports.PropertyImageMetadataSchema = zod_1.z.object({
    alt_text: zod_1.z.string().optional(),
    sort_order: zod_1.z.union([zod_1.z.string().regex(/^\d+$/).transform(Number), zod_1.z.number().int().nonnegative()]).optional(),
    is_primary: zod_1.z.union([
        zod_1.z.string().toLowerCase().transform(v => v === 'true'),
        zod_1.z.boolean()
    ]).optional(),
});
exports.EmptyBodySchema = zod_1.z.object({}).strict();
exports.AttendanceQRPayloadSchema = zod_1.z.object({
    qrPayload: zod_1.z.string().min(10, 'QR payload is required')
});
exports.AttendanceHolidaySchema = zod_1.z.object({
    name: zod_1.z.string().min(2, 'Holiday name is required'),
    date: zod_1.z.string().min(10, 'Holiday date is required')
});
exports.EmployeeSelfUpdateSchema = zod_1.z.object({
    full_name: zod_1.z.string().min(1).optional(),
    phone: zod_1.z.string().min(10).optional(),
    secondary_phone: zod_1.z.string().optional().nullable(),
    whatsapp_number: zod_1.z.string().optional().nullable(),
    current_address: zod_1.z.string().optional().nullable(),
    permanent_address: zod_1.z.string().optional().nullable(),
    emergency_contact_name: zod_1.z.string().optional().nullable(),
    emergency_contact_relation: zod_1.z.string().optional().nullable(),
    emergency_contact_phone: zod_1.z.string().optional().nullable(),
    blood_group: zod_1.z.string().optional().nullable(),
    social_links: zod_1.z.string().optional().nullable(),
    pan_number: zod_1.z.string().regex(/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/, 'Invalid PAN format').optional().nullable(),
    aadhaar_number: zod_1.z.string().regex(/^\d{12}$/, 'Aadhaar must be 12 digits').optional().nullable(),
    bank_name: zod_1.z.string().optional().nullable(),
    bank_account_number: zod_1.z.string().optional().nullable(),
    bank_ifsc: zod_1.z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Invalid IFSC format').optional().nullable(),
    bank_branch: zod_1.z.string().optional().nullable(),
});
exports.EmployeeCreateSchema = zod_1.z.object({
    full_name: zod_1.z.string().min(1, 'Full name is required'),
    phone: zod_1.z.string().min(10, 'Phone is required'),
    role_name: zod_1.z.string().min(1, 'Role name is required'),
    branch_id: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]),
    secondary_phone: zod_1.z.string().optional().nullable(),
    whatsapp_number: zod_1.z.string().optional().nullable(),
    email: zod_1.z.string().email().optional().nullable(),
    blood_group: zod_1.z.string().optional().nullable(),
    social_links: zod_1.z.string().optional().nullable(),
    current_address: zod_1.z.string().optional().nullable(),
    permanent_address: zod_1.z.string().optional().nullable(),
    emergency_contact_name: zod_1.z.string().optional().nullable(),
    emergency_contact_relation: zod_1.z.string().optional().nullable(),
    emergency_contact_phone: zod_1.z.string().optional().nullable(),
    pan_number: zod_1.z.string().regex(/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/, 'Invalid PAN format').optional().nullable(),
    aadhaar_number: zod_1.z.string().regex(/^\d{12}$/, 'Aadhaar must be 12 digits').optional().nullable(),
    bank_name: zod_1.z.string().optional().nullable(),
    bank_account_number: zod_1.z.string().optional().nullable(),
    bank_ifsc: zod_1.z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Invalid IFSC format').optional().nullable(),
    bank_branch: zod_1.z.string().optional().nullable(),
    job_title: zod_1.z.string().optional().nullable(),
    department: zod_1.z.string().optional().nullable(),
    employment_type: zod_1.z.string().optional().nullable(),
    reporting_manager_id: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).optional().nullable(),
    date_of_joining: zod_1.z.string().optional().nullable(),
    salary_ctc: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).optional().nullable(),
    background_education: zod_1.z.string().optional().nullable(),
    additional_branch_ids: zod_1.z.array(zod_1.z.union([zod_1.z.string(), zod_1.z.number()])).optional(),
    initial_password: zod_1.z.string()
        .min(8, 'Password must be at least 8 characters long')
        .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
        .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
        .regex(/[0-9]/, 'Password must contain at least one number')
        .regex(/[^A-Za-z0-9]/, 'Password must contain at least one special character')
        .optional().nullable(),
    company_id: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).optional().nullable(),
});
exports.EmployeeUpdateSchema = exports.EmployeeSelfUpdateSchema.extend({
    email: zod_1.z.string().email().optional().nullable(),
    salary_ctc: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).optional().nullable(),
    job_title: zod_1.z.string().optional().nullable(),
    department: zod_1.z.string().optional().nullable(),
    employment_type: zod_1.z.string().optional().nullable(),
    report_required: zod_1.z.boolean().optional().nullable(),
    reporting_manager_id: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).optional().nullable(),
    date_of_joining: zod_1.z.string().optional().nullable(),
    background_education: zod_1.z.string().optional().nullable(),
    branch_id: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).optional().nullable(),
    status: zod_1.z.string().optional().nullable(),
    attendance_required: zod_1.z.boolean().optional().nullable(),
    role_name: zod_1.z.string().optional().nullable(),
});
exports.EmployeeRolesUpdateSchema = zod_1.z.object({
    role_names: zod_1.z.array(zod_1.z.string()).min(1, 'At least one role is required')
});
