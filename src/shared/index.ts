import { z } from 'zod';

export const CompanySchema = z.object({
  id: z.number().int(),
  name: z.string().min(2),
  code: z.string(),
  property_type_group: z.enum(['RADHA_REAL_HOMES', 'SONTHILLU']),
});

export type Company = z.infer<typeof CompanySchema>;

// Roles
export const Roles = {
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
} as const;

export type RoleName = typeof Roles[keyof typeof Roles];

// Permanent 2-Letter Department Codes for Employee IDs: RRH-{DEPT_2DIGIT}-{NUMBER_3DIGIT}
// Employee IDs remain static and permanent for life even when promoted!
export const DepartmentCodes: Record<string, string> = {
  [Roles.MD]: 'EX',
  [Roles.ADMIN]: 'EX',
  [Roles.HR_MANAGER]: 'HR',
  [Roles.TELECALLER]: 'SL',
  [Roles.AGENT]: 'SL',
  [Roles.PROJECT_MANAGER]: 'OP',
  [Roles.DIGITAL_MARKETING_EXECUTIVE]: 'MK',
  [Roles.DIGITAL_MARKETING_HEAD]: 'MK',
  [Roles.DIGITAL_LEAD_OPERATOR]: 'MK',
  [Roles.FINANCE]: 'FN',
  [Roles.MARKETING_DIRECTOR]: 'MK',
  [Roles.SALES_MANAGER]: 'SL',
  [Roles.CHANNEL_PARTNER_MANAGER]: 'CP',
};

// Canonical Permissions Model (Phase 1 - Stage 2 Blueprint Section 7)
export const Permissions = {
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
} as const;

export type Permission = typeof Permissions[keyof typeof Permissions];

const ALL_PERMISSIONS = Object.values(Permissions);

// Role -> Permission Matrix (Phase 1 - Stage 2 Blueprint Section 8)
export const RolePermissionsMatrix: Record<RoleName, string[]> = {
  [Roles.MD]: ALL_PERMISSIONS, // MD gets all permissions
  
  [Roles.ADMIN]: ALL_PERMISSIONS,
  
  [Roles.HR_MANAGER]: [
    Permissions.EMPLOYEES_CREATE,
    Permissions.EMPLOYEES_READ,
    Permissions.EMPLOYEES_UPDATE,
    Permissions.EMPLOYEES_RESET_PASSWORD,
    Permissions.EMPLOYEES_VIEW_SENSITIVE,
    Permissions.ATTENDANCE_PROPOSALS_QUEUE,
    Permissions.ATTENDANCE_LIVE_MONITOR,
    Permissions.TASKS_CREATE,
    Permissions.TASKS_READ,
    Permissions.TASKS_UPDATE,
    Permissions.TASKS_ASSIGN,
    Permissions.REPORTS_READ_TEAM,
    Permissions.PERFORMANCE_READ_TEAM,
    Permissions.DOCUMENTS_CREATE,
    Permissions.DOCUMENTS_READ,
    Permissions.CUSTOMERS_KYC_WRITE,
  ],
  
  [Roles.FINANCE]: [
    Permissions.EXPENSES_REVIEW,
    Permissions.EXPENSES_MARK_REFUNDED,
    Permissions.EMPLOYEES_VIEW_SENSITIVE, // Finance receives authorized sensitive fields
    Permissions.BOOKINGS_READ,
    Permissions.BOOKINGS_UPDATE,
    Permissions.PAYMENTS_CREATE,
    Permissions.PAYMENTS_READ,
    Permissions.PAYMENTS_UPDATE,
    Permissions.PAYMENTS_CANCEL,
    Permissions.DOCUMENTS_CREATE,
    Permissions.DOCUMENTS_READ,
    Permissions.DOCUMENTS_VERIFY,
    Permissions.CUSTOMERS_KYC_WRITE,
    Permissions.COMPLAINTS_READ,
  ],
  
[Roles.MARKETING_DIRECTOR]: [
    Permissions.TASKS_CREATE,
    Permissions.LEADS_CREATE,
    Permissions.LEADS_READ,
    Permissions.LEADS_UPDATE,
    Permissions.LEADS_DELETE,
    Permissions.LEADS_ASSIGN,
    Permissions.LEADS_BULK_UPLOAD,
    Permissions.CUSTOMERS_CREATE,
    Permissions.CUSTOMERS_READ,
    Permissions.CUSTOMERS_UPDATE,
    Permissions.CUSTOMERS_DELETE,
    Permissions.CUSTOMERS_CONVERT,
    Permissions.PROPERTIES_DM_POLISH,
    Permissions.PROPERTIES_MD_APPROVE, // Per Section 8 participation
    Permissions.SITE_VISITS_READ,
    Permissions.REPORTS_TARGETS_CONFIGURE,
    Permissions.REPORTS_READ_TEAM,
    Permissions.PERFORMANCE_READ_TEAM,
    Permissions.BOOKINGS_READ,
    Permissions.PAYMENTS_READ,
    Permissions.DOCUMENTS_CREATE,
    Permissions.DOCUMENTS_READ,
  ],
  
  [Roles.PROJECT_MANAGER]: [
    Permissions.PROJECTS_CREATE,
    Permissions.PROJECTS_READ,
    Permissions.PROJECTS_UPDATE,
    Permissions.PROJECTS_DELETE,
    Permissions.PROPERTIES_CREATE,
    Permissions.PROPERTIES_VERIFY,
    Permissions.PROPERTIES_READ,
    Permissions.PROPERTIES_UPDATE,
    Permissions.SITE_VISITS_READ,
    Permissions.SITE_VISITS_ASSIGN_AGENT,
    Permissions.TASKS_CREATE,
    Permissions.TASKS_READ,
    Permissions.TASKS_UPDATE,
    Permissions.TASKS_ASSIGN,
    Permissions.LEADS_READ,
    Permissions.CUSTOMERS_READ,
    Permissions.CUSTOMERS_UPDATE,
    Permissions.REPORTS_READ_OWN,
    Permissions.BOOKINGS_READ,
    Permissions.PAYMENTS_READ,
    Permissions.DOCUMENTS_CREATE,
    Permissions.DOCUMENTS_READ,
    Permissions.COMPLAINTS_CREATE,
    Permissions.COMPLAINTS_READ,
    Permissions.COMPLAINTS_UPDATE,
    Permissions.COMPLAINTS_ASSIGN,
    Permissions.COMPLAINTS_RESOLVE,
    Permissions.COMPLAINTS_CLOSE,
  ],
  
  [Roles.DIGITAL_LEAD_OPERATOR]: [
    Permissions.LEADS_CREATE,
    Permissions.LEADS_READ,
    Permissions.LEADS_UPDATE,
    Permissions.LEADS_ASSIGN,
    Permissions.LEADS_BULK_UPLOAD,
    Permissions.LEADS_DISTRIBUTION_MONITOR,
    Permissions.CUSTOMERS_CREATE,
    Permissions.CUSTOMERS_READ,
    Permissions.CUSTOMERS_UPDATE,
    Permissions.CUSTOMERS_DELETE,
    Permissions.CUSTOMERS_CONVERT,
    Permissions.SITE_VISITS_CREATE,
    Permissions.SITE_VISITS_VERIFY,
    Permissions.REPORTS_TARGETS_CONFIGURE,
    Permissions.BOOKINGS_CREATE,
    Permissions.BOOKINGS_READ,
    Permissions.BOOKINGS_UPDATE,
    Permissions.PAYMENTS_CREATE,
    Permissions.PAYMENTS_READ,
    Permissions.DOCUMENTS_CREATE,
    Permissions.DOCUMENTS_READ,
    Permissions.COMPLAINTS_READ,
    Permissions.COMPLAINTS_UPDATE,
  ],
  
  [Roles.TELECALLER]: [
    Permissions.PROJECTS_READ,
    Permissions.LEADS_CREATE,
    Permissions.LEADS_READ,
    Permissions.LEADS_UPDATE,
    Permissions.LEADS_WHATSAPP_PROPOSAL,
    Permissions.CUSTOMERS_READ,
    Permissions.CUSTOMERS_UPDATE,
    Permissions.CUSTOMERS_CONVERT,
    Permissions.SITE_VISITS_CREATE,
    Permissions.SITE_VISITS_READ,
    Permissions.TASKS_READ,
    Permissions.TASKS_UPDATE,
    Permissions.ATTENDANCE_READ_OWN,
    Permissions.ATTENDANCE_SCAN,
    Permissions.ATTENDANCE_LATE_PROPOSAL,
    Permissions.ATTENDANCE_LEAVE_PROPOSAL,
    Permissions.REPORTS_CREATE,
    Permissions.REPORTS_READ_OWN,
    Permissions.PERFORMANCE_READ_OWN,
    Permissions.BOOKINGS_READ,
    Permissions.PAYMENTS_READ,
    Permissions.DOCUMENTS_READ,
  ],
  
  [Roles.DIGITAL_MARKETING_HEAD]: [
    Permissions.PROPERTIES_DM_POLISH,
    Permissions.PROPERTIES_READ,
    Permissions.LEADS_READ,
    Permissions.REPORTS_TARGETS_CONFIGURE,
    Permissions.PERFORMANCE_READ_TEAM,
  ],
  
  [Roles.AGENT]: [
    Permissions.SITE_VISITS_READ,
    Permissions.SITE_VISITS_COMPLETE,
    Permissions.CUSTOMERS_READ,
    Permissions.CUSTOMERS_UPDATE,
    Permissions.CUSTOMERS_CONVERT,
    Permissions.TASKS_READ,
    Permissions.TASKS_UPDATE,
    Permissions.ATTENDANCE_READ_OWN,
    Permissions.ATTENDANCE_SCAN,
    Permissions.REPORTS_CREATE,
    Permissions.REPORTS_READ_OWN,
    Permissions.PERFORMANCE_READ_OWN,
    Permissions.BOOKINGS_READ,
    Permissions.PAYMENTS_READ,
    Permissions.DOCUMENTS_READ,
    Permissions.COMPLAINTS_CREATE,
    Permissions.COMPLAINTS_READ,
    Permissions.COMPLAINTS_UPDATE,
    Permissions.COMPLAINTS_ASSIGN,
    Permissions.COMPLAINTS_RESOLVE,
    Permissions.COMPLAINTS_CLOSE,
  ],
  
  [Roles.DIGITAL_MARKETING_EXECUTIVE]: [
    Permissions.LEADS_READ,
    Permissions.LEADS_UPDATE,
    Permissions.SITE_VISITS_READ,
    Permissions.TASKS_READ,
    Permissions.TASKS_UPDATE,
    Permissions.REPORTS_CREATE,
    Permissions.REPORTS_READ_OWN,
    Permissions.ATTENDANCE_READ_OWN,
    Permissions.ATTENDANCE_SCAN,
    Permissions.PERFORMANCE_READ_OWN,
  ],
  
  [Roles.SALES_MANAGER]: [
    Permissions.TASKS_CREATE,
    Permissions.LEADS_READ,
    Permissions.LEADS_UPDATE,
    Permissions.LEADS_ASSIGN,
    Permissions.LEADS_DISTRIBUTION_MONITOR,
    Permissions.LEADS_WHATSAPP_PROPOSAL,
    Permissions.CUSTOMERS_READ,
    Permissions.CUSTOMERS_UPDATE,
    Permissions.SITE_VISITS_READ,
    Permissions.SITE_VISITS_ASSIGN_AGENT,
    Permissions.TASKS_READ,
    Permissions.TASKS_UPDATE,
    Permissions.TASKS_ASSIGN,
    Permissions.REPORTS_READ_TEAM,
    Permissions.REPORTS_TARGETS_CONFIGURE,
    Permissions.PERFORMANCE_READ_TEAM,
    Permissions.BOOKINGS_READ,
  ],
  
  [Roles.CHANNEL_PARTNER_MANAGER]: [
    Permissions.LEADS_CREATE,
    Permissions.LEADS_READ,
    Permissions.LEADS_UPDATE,
    Permissions.LEADS_WHATSAPP_PROPOSAL,
    Permissions.PROJECTS_READ,
    Permissions.PROPERTIES_READ,
    Permissions.ATTENDANCE_READ_OWN,
    Permissions.ATTENDANCE_SCAN,
    Permissions.ATTENDANCE_LATE_PROPOSAL,
    Permissions.ATTENDANCE_LEAVE_PROPOSAL,
    Permissions.REPORTS_CREATE,
    Permissions.REPORTS_READ_OWN,
    Permissions.PERFORMANCE_READ_OWN,
    Permissions.TASKS_READ,
    Permissions.TASKS_UPDATE,
    Permissions.TASKS_CREATE,
    Permissions.BOOKINGS_READ,
    Permissions.PAYMENTS_READ,
    Permissions.DOCUMENTS_READ,
    Permissions.SITE_VISITS_CREATE,
    Permissions.SITE_VISITS_READ,
    Permissions.CUSTOMERS_READ,
    Permissions.CUSTOMERS_UPDATE,
    Permissions.CUSTOMERS_CONVERT,
  ]
};

// Employee Code Regex: e.g. RRH-EX-001 (MD), RRH-EX-002 (Admin), RRH-HR-001 (HR), RRH-SL-001 (Sales/Telecaller), DEV-SM-001
export const EMPLOYEE_CODE_REGEX = /^(RRH|DEV|SON)-[A-Z]{2,5}-\d{3,5}$/;


// Login Request Schema
export const LoginSchema = z.object({
  employee_code: z
    .string()
    .trim()
    .toUpperCase()
    .min(1, 'Employee ID is required')
    .regex(
      EMPLOYEE_CODE_REGEX,
      'Invalid Employee ID format. Expected format: RRH-XX-000'
    ),
  password: z.string().min(6, 'Password must be at least 6 characters'),
});

export type LoginInput = z.infer<typeof LoginSchema>;

// Attendance Status
export const AttendanceStatus = {
  PRESENT: 'PRESENT',
  LATE: 'LATE',
  APPROVED_LATE: 'APPROVED_LATE',
  HALF_DAY: 'HALF_DAY',
  APPROVED_HALF_DAY: 'APPROVED_HALF_DAY',
  ABSENT: 'ABSENT',
  LEAVE: 'LEAVE',
} as const;

export type AttendanceStatusType = typeof AttendanceStatus[keyof typeof AttendanceStatus];

// Password Change Schema (Forced first login)
export const ChangePasswordSchema = z.object({
  current_password: z.string().min(1, 'Current password is required'),
  new_password: z
    .string()
    .min(8, 'New password must be at least 8 characters')
    .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
    .regex(/[0-9]/, 'Password must contain at least one number'),
});

export type ChangePasswordInput = z.infer<typeof ChangePasswordSchema>;

// Late Proposal Schema (< 09:30 AM IST)
export const LateProposalSchema = z.object({
  date: z.string().min(1, 'Date is required'), // YYYY-MM-DD
  expected_time: z.string().min(1, 'Expected arrival time is required'), // HH:mm
  reason: z.string().min(5, 'Reason must be at least 5 characters'),
});

export type LateProposalInput = z.infer<typeof LateProposalSchema>;

// Leave Proposal Schema (>= 1 day advance)
export const LeaveProposalSchema = z.object({
  start_date: z.string().min(1, 'Start date is required'),
  end_date: z.string().min(1, 'End date is required'),
  reason: z.string().min(5, 'Reason must be at least 5 characters'),
});

export type LeaveProposalInput = z.infer<typeof LeaveProposalSchema>;

// Task Constants
export const TaskPriority = {
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  URGENT: 'URGENT',
} as const;

export type TaskPriorityType = typeof TaskPriority[keyof typeof TaskPriority];

export const TaskStatus = {
  PENDING: 'PENDING',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  OVERDUE: 'OVERDUE',
} as const;

export type TaskStatusType = typeof TaskStatus[keyof typeof TaskStatus];

// Daily Report Schema (with 15-character minimum below_target_reason check)
export const DailyReportSchema = z.object({
  role_name: z.string().min(1),
  metrics: z.record(z.any()), // Role-specific key-value pairs (e.g. callsMade, siteVisits)
  summary_notes: z.string().min(5, 'Summary notes must be at least 5 characters'),
  below_target_reason: z
    .string()
    .min(15, 'Reason for missing target must be at least 15 characters long')
    .optional()
    .or(z.literal(''))
    .or(z.null()),
});

export type DailyReportInput = z.infer<typeof DailyReportSchema>;

// Daily Target Set Schema (for MD & Marketing Director Target Configurator)
export const DailyTargetSetSchema = z.object({
  role_name: z.string().min(1),
  employee_id: z.number().int().optional().nullable(),
  target_type: z.enum(['COUNT', 'CHECKLIST']),
  targets_json: z.record(z.any()),
  form_schema_json: z.array(z.any()).optional(),
  start_date: z.string().optional(),
  end_date: z.string().optional().nullable(),
});

export type DailyTargetSetInput = z.infer<typeof DailyTargetSetSchema>;

// Task Create Schema
export const TaskCreateSchema = z.object({
  title: z.string().min(3, 'Title must be at least 3 characters'),
  description: z.string().optional(),
  assignee_id: z.number().int().positive(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).default('MEDIUM'),
  deadline: z.string().min(1, 'Deadline date/time is required'),
  lead_id: z.number().int().positive().optional().nullable(),
  opportunity_id: z.number().int().positive().optional().nullable(),
  booking_id: z.number().int().positive().optional().nullable(),
});

export type TaskCreateInput = z.infer<typeof TaskCreateSchema>;

// Task Status Update Schema
export const TaskUpdateStatusSchema = z.object({
  status: z.enum(['PENDING', 'IN_PROGRESS', 'COMPLETED', 'OVERDUE']),
});

export type TaskUpdateStatusInput = z.infer<typeof TaskUpdateStatusSchema>;

// Lead Constants & Schemas
export const LeadStatus = {
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
} as const;

export type LeadStatusType = typeof LeadStatus[keyof typeof LeadStatus];

export const LeadSource = {
  MANUAL_ENTRY: 'MANUAL_ENTRY',
  BULK_UPLOAD: 'BULK_UPLOAD',
  WEBSITE: 'WEBSITE',
  FACEBOOK_ADS: 'FACEBOOK_ADS',
  GOOGLE_ADS: 'GOOGLE_ADS',
  WALK_IN: 'WALK_IN',
  REFERRAL: 'REFERRAL',
  HOUSING_COM: 'HOUSING_COM',
} as const;

export const LeadCreateSchema = z.object({
  customer_name: z.string().min(2, 'Customer name is required'),
  phone: z.string().min(10, 'Valid phone number is required'),
  email: z.string().email('Invalid email address').optional().or(z.literal('')),
  source: z.string().default('MANUAL_ENTRY'),
  property_type_preference: z.string().optional(),
  budget_min: z.number().optional().nullable(),
  budget_max: z.number().optional().nullable(),
  preferred_location: z.string().optional(),
  notes: z.string().optional(),
  campaign: z.string().optional().nullable(),
  utm_source: z.string().optional().nullable(),
  utm_medium: z.string().optional().nullable(),
  utm_campaign: z.string().optional().nullable(),
  referral_person_name: z.string().optional().nullable(),
  referral_employee_id: z.number().optional().nullable(),
});

export type LeadCreateInput = z.infer<typeof LeadCreateSchema>;

// Website public lead intake — mirrors the fields the public API currently accepts.
// Intentionally narrower than the internal LeadCreateSchema (no source/campaign/UTM:
// source is forced to WEBSITE server-side).
export const PublicLeadCreateSchema = z.object({
  customer_name: z.string().min(2, 'Customer name is required'),
  phone: z.string().min(10, 'Valid phone number is required'),
  email: z.string().email('Invalid email address').optional().or(z.literal('')),
  property_type_preference: z.string().optional(),
  preferred_location: z.string().optional(),
  enquiry_type: z.enum(['appraisal', 'call', 'project', 'property', 'consultation', 'other']).optional(),
  preferred_contact_time: z.enum(['immediate', 'business_hours', 'after_hours', 'anytime']).optional(),
  property_ids: z.array(z.number().int().positive()).max(10).optional(),
  project_id: z.number().int().positive().optional().nullable(),
  budget_max: z.number().positive('Budget must be a positive number').optional().nullable(),
  notes: z.string().optional(),
});

export type PublicLeadCreateInput = z.infer<typeof PublicLeadCreateSchema>;

export const LeadStatusUpdateSchema = z.object({
  status: z.enum([
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
  notes: z.string().optional(),
  // §1 guard fields — required for specific transitions (enforced in service)
  exit_reason: z.string().optional(), // required when status -> DROPPED
  demo_scheduled_at: z.string().datetime().optional(), // required when status -> DEMO_SCHEDULED
  demo_handler_id: z.number().int().positive().optional(), // required when status -> DEMO_SCHEDULED
  qualification: z.object({
    budget_min: z.number().nonnegative().optional(),
    budget_max: z.number().nonnegative().optional(),
    property_type_preference: z.string().optional(),
    preferred_location: z.string().optional(),
  }).partial().optional(),
});


export type LeadStatusUpdateInput = z.infer<typeof LeadStatusUpdateSchema>;

export const LeadReassignSchema = z.object({
  assigned_to_id: z.number().int().positive('Assignee ID is required'),
  reason: z.string().min(3, 'Reassignment reason is required'),
});

export type LeadReassignInput = z.infer<typeof LeadReassignSchema>;

// Project Constants & Schemas
export const ProjectCreateSchema = z.object({
  name: z.string().min(3),
  description: z.string().optional(),
  location: z.string().min(3),
  total_area: z.string().optional(),
  launch_date: z.string().optional(),
  amenities: z.any().optional(),
  assigned_pm_id: z.number().int().positive().optional().nullable(),
});

export type ProjectCreateInput = z.infer<typeof ProjectCreateSchema>;

export const ProjectUpdateSchema = z.object({
  name: z.string().min(3).optional(),
  description: z.string().optional(),
  location: z.string().min(3).optional(),
  total_area: z.string().optional(),
  launch_date: z.string().optional(),
  amenities: z.any().optional(),
  assigned_pm_id: z.number().int().positive().optional().nullable(),
  status: z.enum(['PLANNING', 'UNDER_CONSTRUCTION', 'COMPLETED', 'CANCELLED']).optional(),
});

export type ProjectUpdateInput = z.infer<typeof ProjectUpdateSchema>;
export const AddPropertyInterestSchema = z.object({
  property_id: z.number().int().positive(),
});

// Property Constants & Schemas
export const PropertyStatus = {
  PENDING_VERIFICATION: 'PENDING_VERIFICATION',
  PENDING_DM_POLISH: 'PENDING_DM_POLISH',
  PENDING_MD_APPROVAL: 'PENDING_MD_APPROVAL',
  LIVE: 'LIVE',
  REJECTED: 'REJECTED',
  LOCKED: 'LOCKED',
  BOOKED: 'BOOKED',
  SOLD: 'SOLD',
} as const;

export type PropertyStatusType = typeof PropertyStatus[keyof typeof PropertyStatus];

export const PropertyAvailability = {
  AVAILABLE: 'AVAILABLE',
  RESERVED: 'RESERVED',
  SOLD: 'SOLD',
  UNAVAILABLE: 'UNAVAILABLE',
} as const;

export type PropertyAvailabilityType = typeof PropertyAvailability[keyof typeof PropertyAvailability];

export const PropertyBrand = {
  SONTHILLU: 'SONTHILLU', // Residential Villas & Apartments
  RADHA_REAL_HOMES: 'RADHA_REAL_HOMES', // Commercial Plots & Land
} as const;

export const PropertyCreateSchema = z.object({
  title: z.string().min(3, 'Title is required'),
  description: z.string().optional(),
  brand_type: z.enum(['SONTHILLU', 'RADHA_REAL_HOMES']),
  category: z.enum([
    'APARTMENT', 'INDEPENDENT_HOUSE', 'DUPLEX', 'INDEPENDENT_FLOOR', 
    'VILLA', 'PENTHOUSE', 'STUDIO', 'PLOT', 'FARM_HOUSE', 'AGRICULTURAL_LAND'
  ]),
  price: z.number().positive('Price must be greater than 0'),
  area_sqft: z.number().positive('Area in sqft is required'),
  location: z.string().min(2, 'Location is required'),
  address: z.string().optional(),
  bedrooms: z.number().int().optional().nullable(),
  bathrooms: z.number().int().optional().nullable(),
  facing: z.string().optional(),
  amenities: z.string().optional(),
  possession_status: z.enum(['READY_TO_MOVE', 'UNDER_CONSTRUCTION']).optional(),
  assigned_pm_id: z.number().int().optional().nullable(),
  details: z.any().optional(),
  // WR-2: Structured location fields
  state: z.string().optional().nullable(),
  city: z.string().optional().nullable(),
  locality: z.string().optional().nullable(),
  pincode: z.string().optional().nullable(),
  latitude: z.number().optional().nullable(),
  longitude: z.number().optional().nullable(),
  listing_type: z.enum(['NEW', 'RESALE']).optional(),
  source: z.enum(['INTERNAL', 'WEBSITE_SELLER']).optional(),
});

export type PropertyCreateInput = z.infer<typeof PropertyCreateSchema>;

export const PropertyVerificationSchema = z.object({
  approved: z.boolean(),
  notes: z.string().min(3, 'Verification notes required'),
  assigned_pm_id: z.number().int().optional(),
});

export type PropertyVerificationInput = z.infer<typeof PropertyVerificationSchema>;

export const PropertyDMUpdateSchema = z.object({
  digital_marketing_executive_id: z.number().int().positive('Must select a Digital Marketing Executive'),
  seo_title: z.string().optional(),
  seo_keywords: z.string().optional(),
  description: z.string().optional(),
  notes: z.string().optional(),
});

export type PropertyDMUpdateInput = z.infer<typeof PropertyDMUpdateSchema>;

export const PropertyDMVerifyAsIsSchema = z.object({
  notes: z.string().optional(),
});
export type PropertyDMVerifyAsIsInput = z.infer<typeof PropertyDMVerifyAsIsSchema>;

export const PropertyMDApprovalSchema = z.object({
  approved: z.boolean(),
  comments: z.string().optional(),
});

export type PropertyMDApprovalInput = z.infer<typeof PropertyMDApprovalSchema>;

export const PropertyUpdateSchema = z.object({
  title: z.string().min(3).optional(),
  description: z.string().optional(),
  type: z.enum(['APARTMENT', 'VILLA', 'PLOT', 'COMMERCIAL']).optional(),
  price: z.number().positive().optional(),
  size: z.string().optional(),
  location: z.string().min(3).optional(),
  bhk: z.number().int().positive().optional(),
  facing: z.string().optional(),
  amenities: z.any().optional(),
  project_id: z.number().int().positive().nullable().optional(),
  status: z.enum(['PENDING_VERIFICATION', 'PENDING_DM_POLISH', 'PENDING_MD_APPROVAL', 'LIVE', 'REJECTED', 'LOCKED', 'BOOKED', 'SOLD']).optional(),
  // WR-2: Structured location fields
  state: z.string().optional().nullable(),
  city: z.string().optional().nullable(),
  locality: z.string().optional().nullable(),
  pincode: z.string().optional().nullable(),
  latitude: z.number().optional().nullable(),
  longitude: z.number().optional().nullable(),
  listing_type: z.enum(['NEW', 'RESALE']).optional(),
});

export type PropertyUpdateInput = z.infer<typeof PropertyUpdateSchema>;

export const PropertyPublicationSchema = z.object({
  property_id: z.number().int().positive(),
  company_id: z.number().int().positive(),
  is_published: z.boolean(),
});

export type PropertyPublicationInput = z.infer<typeof PropertyPublicationSchema>;

// Expense Refund Constants & Schemas
export const ExpenseRefundStatus = {
  PENDING: 'PENDING',
  ACCOUNTANT_APPROVED: 'ACCOUNTANT_APPROVED',
  MD_APPROVED: 'MD_APPROVED',
  REFUNDED: 'REFUNDED',
  REJECTED_BY_ACCOUNTANT: 'REJECTED_BY_ACCOUNTANT',
  REJECTED_BY_MD: 'REJECTED_BY_MD',
} as const;

export type ExpenseRefundStatusType = typeof ExpenseRefundStatus[keyof typeof ExpenseRefundStatus];

export const ExpenseRefundCreateSchema = z.object({
  purpose: z.string().min(3, 'Purpose is required'),
  amount: z.number().positive('Amount must be greater than 0'),
});

export type ExpenseRefundCreateInput = z.infer<typeof ExpenseRefundCreateSchema>;

export const ExpenseRefundAccountantReviewSchema = z.object({
  decision: z.enum(['APPROVE', 'REJECT']),
  note: z.string().optional(),
});

export type ExpenseRefundAccountantReviewInput = z.infer<typeof ExpenseRefundAccountantReviewSchema>;

export const ExpenseRefundMDReviewSchema = z.object({
  decision: z.enum(['APPROVE', 'REJECT']),
  note: z.string().optional(),
});

export type ExpenseRefundMDReviewInput = z.infer<typeof ExpenseRefundMDReviewSchema>;

export const ExpenseRefundMarkRefundedSchema = z.object({});

export type ExpenseRefundMarkRefundedInput = z.infer<typeof ExpenseRefundMarkRefundedSchema>;



// ─────────────────────────────────────────────────────────────
// CUSTOMER SCHEMAS
// ─────────────────────────────────────────────────────────────

export const CustomerCreateSchema = z.object({
  first_name: z.string().min(2),
  last_name: z.string().optional(),
  phone: z.string().min(10),
  email: z.string().email().optional(),
  status: z.string().default('ACTIVE'),
  source: z.string().default('MANUAL_ENTRY'),
  assigned_to_id: z.number().optional(),
});

export const CustomerUpdateSchema = z.object({
  first_name: z.string().min(2).optional(),
  last_name: z.string().optional(),
  phone: z.string().min(10).optional(),
  email: z.string().email().optional(),
  status: z.string().optional(),
});

// ─────────────────────────────────────────────────────────────
// DOCUMENT MANAGEMENT — Phase 11
// ─────────────────────────────────────────────────────────────

export const DocumentType = {
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
} as const;

export type DocumentTypeValue = typeof DocumentType[keyof typeof DocumentType];

export const DocumentStatus = {
  ACTIVE: 'ACTIVE',
  ARCHIVED: 'ARCHIVED',
} as const;

export type DocumentStatusValue = typeof DocumentStatus[keyof typeof DocumentStatus];

export const DocumentVerificationStatus = {
  PENDING: 'PENDING',
  VERIFIED: 'VERIFIED',
  REJECTED: 'REJECTED',
} as const;

export type DocumentVerificationStatusValue = typeof DocumentVerificationStatus[keyof typeof DocumentVerificationStatus];

// Document type -> required entity FK mapping
export const DOCUMENT_TYPE_ENTITY_REQUIREMENTS: Record<string, { required: string[]; optional: string[] }> = {
  [DocumentType.KYC_PAN]: { required: ['customer_id'], optional: [] },
  [DocumentType.KYC_AADHAAR]: { required: ['customer_id'], optional: [] },
  [DocumentType.BOOKING_AGREEMENT]: { required: ['booking_id'], optional: ['customer_id'] },
  [DocumentType.BOOKING_RECEIPT]: { required: ['booking_id'], optional: ['payment_id'] },
  [DocumentType.PAYMENT_RECEIPT]: { required: ['payment_id'], optional: ['booking_id'] },
  [DocumentType.SALE_DEED]: { required: ['booking_id'], optional: ['property_id', 'customer_id'] },
  [DocumentType.PROPERTY_TITLE]: { required: ['property_id'], optional: ['project_id'] },
  [DocumentType.PROPERTY_PLAN]: { required: ['property_id'], optional: ['project_id'] },
  [DocumentType.PROPOSAL]: { required: ['lead_id'], optional: ['opportunity_id'] },
  [DocumentType.OTHER]: { required: [], optional: ['customer_id', 'lead_id', 'opportunity_id', 'booking_id', 'property_id', 'project_id', 'payment_id'] },
};

export const DocumentUploadSchema = z.object({
  document_type: z.enum([
    'KYC_PAN', 'KYC_AADHAAR', 'BOOKING_AGREEMENT', 'PAYMENT_RECEIPT',
    'BOOKING_RECEIPT', 'SALE_DEED', 'PROPERTY_TITLE', 'PROPERTY_PLAN',
    'PROPOSAL', 'OTHER',
  ]),
  title: z.string().min(1, 'Title is required').max(255),
  customer_id: z.coerce.number().int().positive().optional().nullable(),
  lead_id: z.coerce.number().int().positive().optional().nullable(),
  opportunity_id: z.coerce.number().int().positive().optional().nullable(),
  booking_id: z.coerce.number().int().positive().optional().nullable(),
  property_id: z.coerce.number().int().positive().optional().nullable(),
  project_id: z.coerce.number().int().positive().optional().nullable(),
  payment_id: z.coerce.number().int().positive().optional().nullable(),
  notes: z.string().optional().nullable(),
});

export type DocumentUploadInput = z.infer<typeof DocumentUploadSchema>;

export const DocumentVerifySchema = z.object({
  status: z.enum(['VERIFIED', 'REJECTED']),
  notes: z.string().optional().nullable(),
});

export type DocumentVerifyInput = z.infer<typeof DocumentVerifySchema>;

export const DocumentArchiveSchema = z.object({
  reason: z.string().optional().nullable(),
});

export type DocumentArchiveInput = z.infer<typeof DocumentArchiveSchema>;

// ─────────────────────────────────────────────────────────────
// CUSTOMER PORTAL INTEGRATION — Phase 11 Packet 3B
// ─────────────────────────────────────────────────────────────

export const PortalCallbackStatus = {
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;

export type PortalCallbackStatusValue = typeof PortalCallbackStatus[keyof typeof PortalCallbackStatus];

export const PortalCallbackSchema = z.object({
  idempotency_key: z.string().min(1),
  event_type: z.literal('BOOKING_PORTAL_HANDOFF'),
  status: z.enum(['completed', 'failed']),
  portal_customer_id: z.string().optional().nullable(),
  portal_booking_id: z.string().optional().nullable(),
  company_id: z.number().int().positive(),
  crms_booking_id: z.number().int().positive(),
  message: z.string().optional().nullable(),
});

export type PortalCallbackInput = z.infer<typeof PortalCallbackSchema>;

// ─────────────────────────────────────────────────────────────
// CUSTOMER KYC — Phase 11 Packet 3C (KYC Data Bridge)
// ─────────────────────────────────────────────────────────────

export const KycStatus = {
  PENDING: 'PENDING',
  PARTIAL: 'PARTIAL',
  VERIFIED: 'VERIFIED',
  REJECTED: 'REJECTED',
} as const;

export type KycStatusValue = typeof KycStatus[keyof typeof KycStatus];

export const KYC_STATUSES = Object.values(KycStatus) as string[];

/**
 * CRM-internal KYC write/update path. Encrypted at rest before persistence.
 * Raw PAN/Aadhaar NEVER cross the CRM ↔ Portal boundary (Packet 3C §3.4).
 */
export const CustomerKycWriteSchema = z.object({
  pan_number: z.string().regex(/^[A-Z0-9]{10}$/, 'PAN must be 10 alphanumeric characters').optional(),
  aadhaar_number: z.string().regex(/^\d{12}$/, 'Aadhaar must be 12 digits').optional(),
});

export type CustomerKycWriteInput = z.infer<typeof CustomerKycWriteSchema>;

/**
 * Outbound CRM → Portal KYC status push payload (Packet 3C §3).
 * Contains ONLY status + masked PAN — never raw PAN/Aadhaar/bank data.
 */
export const KycStatusChangedSchema = z.object({
  event_type: z.literal('CUSTOMER_KYC_STATUS_CHANGED'),
  company_id: z.number().int().positive(),
  crms_customer_id: z.number().int().positive(),
  crms_booking_id: z.number().int().positive().nullable(),
  kyc_status: z.enum(['PENDING', 'PARTIAL', 'VERIFIED', 'REJECTED']),
  masked_pan: z.string().nullable(),
  verified_at: z.string().datetime().nullable(),
});

export type KycStatusChangedInput = z.infer<typeof KycStatusChangedSchema>;

// ─────────────────────────────────────────────────────────────
// PORTAL → CRM KYC SUBMISSION CALLBACK — Phase 11 Packet 3D
// ─────────────────────────────────────────────────────────────

/**
 * Inbound Portal → CRM KYC submission callback (Packet 3D).
 * The Portal may report ONLY "submitted" — verification authority stays
 * exclusively in CRM. Raw PAN/Aadhaar/bank/document data is NEVER part of
 * this contract (Packet 3C §3.4 / §4.2).
 */
export const KycCallbackSchema = z.object({
  idempotency_key: z.string().min(1),
  event_type: z.literal('CUSTOMER_KYC_STATUS_CHANGED'),
  status: z.literal('submitted'),
  portal_customer_id: z.string().optional().nullable(),
  company_id: z.number().int().positive(),
  crms_customer_id: z.number().int().positive(),
  crms_booking_id: z.number().int().positive().optional().nullable(),
}).strict();

export type KycCallbackInput = z.infer<typeof KycCallbackSchema>;

// ─────────────────────────────────────────────────────────────
// PAYMENT SYNCHRONIZATION — Phase 11 Packet 3F
// ─────────────────────────────────────────────────────────────

export const PAYMENT_EVENT_TYPE = 'PAYMENT_STATUS_CHANGED';

/**
 * Outbound CRM → Portal payment status push payload (Packet 3F §4).
 * Contains ONLY amounts + identifiers — NEVER card/UPI/bank credentials,
 * CVV, or any raw financial secret (3A–3E sensitive-data policy).
 */
export const PaymentStatusChangedSchema = z.object({
  event_type: z.literal(PAYMENT_EVENT_TYPE),
  company_id: z.number().int().positive(),
  crms_customer_id: z.number().int().positive(),
  crms_booking_id: z.number().int().positive(),
  payment_id: z.number().int().positive(),
  payment_code: z.string().min(1),
  installment_id: z.number().int().positive().nullable(),
  amount: z.number().positive(),
  status: z.enum(['SUCCESS', 'REFUNDED']),
  payment_date: z.string().datetime(),
  reference_number: z.string().nullable().optional(),
});

export type PaymentStatusChangedInput = z.infer<typeof PaymentStatusChangedSchema>;

/**
 * Inbound Portal → CRM payment callback (Packet 3F §5).
 * The Portal may report ONLY "completed" / "failed" — it may never claim
 * SUCCESS/REFUNDED (CRM owns verification, enforced at the schema boundary).
 * References the outbound PAYMENT_STATUS_CHANGED IntegrationEvent via its
 * idempotency key; it NEVER creates a new IntegrationEvent.
 */
export const PaymentCallbackSchema = z.object({
  idempotency_key: z.string().min(1),
  event_type: z.literal(PAYMENT_EVENT_TYPE),
  status: z.enum(['completed', 'failed']),
  company_id: z.number().int().positive(),
  crms_customer_id: z.number().int().positive(),
  crms_booking_id: z.number().int().positive(),
  payment_id: z.number().int().positive(),
  portal_payment_id: z.string().optional().nullable(),
  message: z.string().optional().nullable(),
}).strict();

export type PaymentCallbackInput = z.infer<typeof PaymentCallbackSchema>;

// ─────────────────────────────────────────────────────────────
// INSTALLMENT / FINANCIAL STATUS SYNC — Phase 11 Packet 3H
// ─────────────────────────────────────────────────────────────

export const INSTALLMENT_EVENT_TYPE = 'INSTALLMENT_STATUS_CHANGED';

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
export const InstallmentStatusChangedSchema = z.object({
  event_type: z.literal(INSTALLMENT_EVENT_TYPE),
  company_id: z.number().int().positive(),
  crms_customer_id: z.number().int().positive(),
  crms_booking_id: z.number().int().positive(),
  installment_id: z.number().int().positive(),
  installment_number: z.number().int().positive(),
  status: z.enum(['PENDING', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED']),
  expected_amount: z.number().positive(),
  received_amount: z.number().nonnegative(),
  remaining_amount: z.number().nonnegative(),
  changed_at: z.string().datetime(),
});

export type InstallmentStatusChangedInput = z.infer<typeof InstallmentStatusChangedSchema>;

// ─────────────────────────────────────────────────────────────
// CUSTOMER NOTIFICATIONS — Phase 11 Packet 3E
// ─────────────────────────────────────────────────────────────

export const CustomerNotificationType = {
  PORTAL_ACTIVATED: 'PORTAL_ACTIVATED',
  KYC_STATUS_UPDATED: 'KYC_STATUS_UPDATED',
  PAYMENT_STATUS_UPDATED: 'PAYMENT_STATUS_UPDATED', // Phase 11 Packet 3F
} as const;

export type CustomerNotificationTypeValue = typeof CustomerNotificationType[keyof typeof CustomerNotificationType];

/**
 * Read-only query for the Portal-facing customer-notifications API (Packet 3E).
 * The Portal may only READ; it can never create/update/delete notifications.
 * company_id + crms_customer_id are tenant/customer-scoped (both required).
 */
export const CustomerNotificationReadSchema = z.object({
  company_id: z.number().int().positive(),
  crms_customer_id: z.number().int().positive(),
  page: z.number().int().positive().default(1),
  limit: z.number().int().positive().max(100).default(20),
}).strict();

export type CustomerNotificationReadInput = z.infer<typeof CustomerNotificationReadSchema>;

/**
 * Single customer-notification item returned by the read API (Packet 3E).
 * Carries ONLY low-sensitivity fields — never raw PAN/Aadhaar/bank/salary.
 */
export const CustomerNotificationResponseSchema = z.object({
  id: z.number().int().positive(),
  type: z.string().min(1),
  title: z.string().min(1),
  message: z.string().min(1),
  is_read: z.boolean(),
  booking_id: z.number().int().positive().nullable(),
  created_at: z.string().datetime(),
}).strict();

export type CustomerNotificationResponse = z.infer<typeof CustomerNotificationResponseSchema>;

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
export const IntegrationMetricsQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'from must be YYYY-MM-DD (IST)').optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'to must be YYYY-MM-DD (IST)').optional(),
  includeTimeseries: z.enum(['true', 'false']).optional(),
}).strict();

export type IntegrationMetricsQueryInput = z.infer<typeof IntegrationMetricsQuerySchema>;

/**
 * Response shape for the metrics endpoint. Aggregates ONLY — no raw
 * IntegrationEvent payloads, PAN/Aadhaar, bank data, or other sensitive
 * information ever crosses this contract (3A–3G sensitive-data policy).
 */
export const IntegrationMetricsResponseSchema = z.object({
  generated_at: z.string().datetime(),
  company_id: z.number().int().positive(),
  range: z.object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  }),
  handoffs: z.object({
    total: z.number().int().nonnegative(),
    byStatus: z.record(z.number().int().nonnegative()),
    activationRate: z.number().min(0).max(100).nullable(),
  }),
  outbox: z.object({
    total: z.number().int().nonnegative(),
    byEventType: z.record(z.number().int().nonnegative()),
    byStatus: z.record(z.number().int().nonnegative()),
    retried: z.number().int().nonnegative(),
    terminalFailures: z.number().int().nonnegative(),
  }),
  payments: z.object({
    total: z.number().int().nonnegative(),
    bySyncStatus: z.record(z.number().int().nonnegative()),
    bySource: z.record(z.number().int().nonnegative()),
  }),
  kyc: z.object({
    total: z.number().int().nonnegative(),
    byStatus: z.record(z.number().int().nonnegative()),
    submissions: z.number().int().nonnegative(),
  }),
  notifications: z.object({
    total: z.number().int().nonnegative(),
    byType: z.record(z.number().int().nonnegative()),
  }),
  timeseries: z.object({
    days: z.array(z.record(z.any())),
  }).optional(),
}).strict();

export type IntegrationMetricsResponse = z.infer<typeof IntegrationMetricsResponseSchema>;

// Opportunity Schemas
export const OpportunityCreateSchema = z.object({
  lead_id: z.number().int().positive(),
  owner_id: z.number().int().positive().optional(),
  project_id: z.number().int().positive().optional(),
  property_id: z.number().int().positive().optional(),
  expected_value: z.number().nonnegative().optional(),
  probability: z.number().min(0).max(100).optional(),
  budget_min: z.number().nonnegative().optional(),
  budget_max: z.number().nonnegative().optional(),
});
export type OpportunityCreateInput = z.infer<typeof OpportunityCreateSchema>;

export const OpportunityUpdateSchema = z.object({
  expected_value: z.number().nonnegative().optional(),
  probability: z.number().min(0).max(100).optional(),
  stage: z.string().optional(),
  drop_reason: z.string().optional(),
  budget_min: z.number().nonnegative().optional(),
  budget_max: z.number().nonnegative().optional(),
  property_id: z.number().int().positive().optional(),
});
export type OpportunityUpdateInput = z.infer<typeof OpportunityUpdateSchema>;

// ─────────────────────────────────────────────────────────────
// Site Visit Schemas (§2 Site Visit Sub-Workflow)
// ─────────────────────────────────────────────────────────────

// Full §2 SiteVisitBooking.status state list
export const SiteVisitStatus = {
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
} as const;
export type SiteVisitStatusType = typeof SiteVisitStatus[keyof typeof SiteVisitStatus];

export const SiteVisitOutcome = {
  INTERESTED: 'INTERESTED',
  NOT_INTERESTED: 'NOT_INTERESTED',
} as const;
export type SiteVisitOutcomeType = typeof SiteVisitOutcome[keyof typeof SiteVisitOutcome];

export const SiteVisitCreateSchema = z.object({
  lead_id: z.number().int().positive(),
  // §2: all properties in a single booking must belong to the same project.
  property_ids: z.array(z.number().int().positive()).min(1).optional(),
  project_id: z.number().int().positive().optional(),
  scheduled_date: z.string().datetime(),
  opportunity_id: z.number().int().positive().optional(),
  pick_up_requested: z.boolean().optional().default(false),
  pick_up_address: z.string().optional(),
});
export type SiteVisitCreateInput = z.infer<typeof SiteVisitCreateSchema>;

// Accept (PM/Agent accepts the routed visit)
export const SiteVisitAcceptSchema = z.object({
  notes: z.string().optional(),
});
export type SiteVisitAcceptInput = z.infer<typeof SiteVisitAcceptSchema>;

// Reassign (open chain during initial acceptance) — reason required
export const SiteVisitReassignSchema = z.object({
  to_employee_id: z.number().int().positive(),
  reason: z.string().min(3, 'Reassignment reason is required'),
});
export type SiteVisitReassignInput = z.infer<typeof SiteVisitReassignSchema>;

// Escalate to Marketing Director (no PM/Agent left to try)
export const SiteVisitEscalateSchema = z.object({
  reason: z.string().min(3, 'Escalation reason is required'),
});
export type SiteVisitEscalateInput = z.infer<typeof SiteVisitEscalateSchema>;

// Reschedule (customer requested a date/property change) or release
export const SiteVisitRescheduleSchema = z.object({
  scheduled_date: z.string().datetime().optional(),
  property_ids: z.array(z.number().int().positive()).min(1).optional(),
});
export type SiteVisitRescheduleInput = z.infer<typeof SiteVisitRescheduleSchema>;

// Confirm PM reconfirmation after a reschedule (or release back to open chain)
export const SiteVisitReconfirmSchema = z.object({
  release: z.boolean().optional().default(false),
});
export type SiteVisitReconfirmInput = z.infer<typeof SiteVisitReconfirmSchema>;

// Complete — one outcome row per linked property (outcome_reason required if NOT_INTERESTED)
export const SiteVisitOutcomeSchema = z.object({
  property_id: z.number().int().positive(),
  outcome: z.enum(['INTERESTED', 'NOT_INTERESTED']),
  outcome_reason: z.string().optional(),
});
export type SiteVisitOutcomeInput = z.infer<typeof SiteVisitOutcomeSchema>;

export const SiteVisitCompleteSchema = z.object({
  outcomes: z.array(SiteVisitOutcomeSchema).min(1),
  feedback_notes: z.string().optional(),
  proof_photo_url: z.string().optional(),
});
export type SiteVisitCompleteInput = z.infer<typeof SiteVisitCompleteSchema>;

// Generic update (used by older/aux endpoints; status is free-form here but
// routed through the §2 workflow engine in the service layer).
export const SiteVisitUpdateSchema = z.object({
  scheduled_date: z.string().datetime().optional(),
  status: z.string().optional(),
  notes: z.string().optional(),
  confirmed: z.boolean().optional(),
  verification_notes: z.string().optional(),
  agent_id: z.number().int().positive().optional(),
  rating: z.string().optional(),
  feedback_notes: z.string().optional(),
  proof_photo_url: z.string().optional(),
});
export type SiteVisitUpdateInput = z.infer<typeof SiteVisitUpdateSchema>;

// ─────────────────────────────────────────────────────────────
// Message Template Schema (§5)
// ─────────────────────────────────────────────────────────────
export const MessageTemplateSchema = z.object({
  template_key: z.string().min(2).max(191),
  name: z.string().min(1).max(191),
  body_text: z.string().min(1),
  is_active: z.boolean().optional().default(true),
});
export type MessageTemplateInput = z.infer<typeof MessageTemplateSchema>;

// §5 — stable template_key values for the WhatsApp deep-link touchpoints.
// These are the canonical lookup keys used by resolveTemplate() and by the
// admin template editor. The body_text of each supports the placeholders
// {customer_name}, {property_name}, {pm_name}, {visit_date}.
export const MessageTemplateKey = {
  LEAD_QUALIFIED_PROPERTIES: 'LEAD_QUALIFIED_PROPERTIES', // legacy/alias
  LEAD_PROPERTY_PROPOSAL: 'LEAD_PROPERTY_PROPOSAL', // matched property list + invite to discuss
  DEMO_SCHEDULED: 'DEMO_SCHEDULED', // confirm demo date/time
  SITE_VISIT_SCHEDULED: 'SITE_VISIT_SCHEDULED', // schedule confirmation
  SITE_VISIT_ACCEPTED: 'SITE_VISIT_ACCEPTED', // attending PM/Agent name, phone, property, date/time
  DAY_BEFORE_RECONFIRMATION: 'DAY_BEFORE_RECONFIRMATION', // "confirming your visit tomorrow at X"
  RESCHEDULE_CONFIRMED: 'RESCHEDULE_CONFIRMED', // new date/time confirmation
  POST_VISIT_INTERESTED: 'POST_VISIT_INTERESTED', // thank-you + next steps toward booking
  BOOKING_CONFIRMED: 'BOOKING_CONFIRMED', // welcome + portal credentials
} as const;
export type MessageTemplateKeyType = typeof MessageTemplateKey[keyof typeof MessageTemplateKey];


export const PropertyTogglePublicationBodySchema = z.object({
  company_id: z.number().int().positive(),
  is_published: z.boolean(),
});

export const PropertyImageMetadataSchema = z.object({
  alt_text: z.string().optional(),
  sort_order: z.union([z.string().regex(/^\d+$/).transform(Number), z.number().int().nonnegative()]).optional(),
  is_primary: z.union([
    z.string().toLowerCase().transform(v => v === 'true'),
    z.boolean()
  ]).optional(),
});

export const EmptyBodySchema = z.object({}).strict();


export const AttendanceQRPayloadSchema = z.object({
  qrPayload: z.string().min(10, 'QR payload is required')
});

export const AttendanceHolidaySchema = z.object({
  name: z.string().min(2, 'Holiday name is required'),
  date: z.string().min(10, 'Holiday date is required')
});


export const EmployeeSelfUpdateSchema = z.object({
  full_name: z.string().min(1).optional(),
  phone: z.string().min(10).optional(),
  secondary_phone: z.string().optional().nullable(),
  whatsapp_number: z.string().optional().nullable(),
  email: z.string().optional().nullable(),
  current_address: z.string().optional().nullable(),
  permanent_address: z.string().optional().nullable(),
  emergency_contact_name: z.string().optional().nullable(),
  emergency_contact_relation: z.string().optional().nullable(),
  emergency_contact_phone: z.string().optional().nullable(),
  blood_group: z.string().optional().nullable(),
  social_links: z.string().optional().nullable(),
  pan_number: z.string().regex(/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/, 'Invalid PAN format').or(z.literal('')).optional().nullable(),
  aadhaar_number: z.string().regex(/^\d{12}$/, 'Aadhaar must be 12 digits').or(z.literal('')).optional().nullable(),
  bank_name: z.string().optional().nullable(),
  bank_account_number: z.string().optional().nullable(),
  bank_ifsc: z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Invalid IFSC format').or(z.literal('')).optional().nullable(),
  bank_branch: z.string().optional().nullable(),
});

export const EmployeeCreateSchema = z.object({
  full_name: z.string().min(1, 'Full name is required'),
  phone: z.string().min(10, 'Phone is required'),
  role_name: z.string().min(1, 'Role name is required'),
  branch_id: z.union([z.string(), z.number()]),
  secondary_phone: z.string().optional().nullable(),
  whatsapp_number: z.string().optional().nullable(),
  email: z.string().email().optional().nullable(),
  blood_group: z.string().optional().nullable(),
  social_links: z.string().optional().nullable(),
  current_address: z.string().optional().nullable(),
  permanent_address: z.string().optional().nullable(),
  emergency_contact_name: z.string().optional().nullable(),
  emergency_contact_relation: z.string().optional().nullable(),
  emergency_contact_phone: z.string().optional().nullable(),
  pan_number: z.string().regex(/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/, 'Invalid PAN format').or(z.literal('')).optional().nullable(),
  aadhaar_number: z.string().regex(/^\d{12}$/, 'Aadhaar must be 12 digits').or(z.literal('')).optional().nullable(),
  bank_name: z.string().optional().nullable(),
  bank_account_number: z.string().optional().nullable(),
  bank_ifsc: z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Invalid IFSC format').or(z.literal('')).optional().nullable(),
  bank_branch: z.string().optional().nullable(),
  job_title: z.string().optional().nullable(),
  department: z.string().optional().nullable(),
  employment_type: z.string().optional().nullable(),
  reporting_manager_id: z.union([z.string(), z.number()]).optional().nullable(),
  date_of_joining: z.string().optional().nullable(),
  salary_ctc: z.union([z.string(), z.number()]).optional().nullable(),
  background_education: z.string().optional().nullable(),
  additional_branch_ids: z.array(z.union([z.string(), z.number()])).optional(),
  initial_password: z.string()
    .min(8, 'Password must be at least 8 characters long')
    .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
    .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
    .regex(/[0-9]/, 'Password must contain at least one number')
    .regex(/[^A-Za-z0-9]/, 'Password must contain at least one special character')
    .optional().nullable(),
  company_id: z.union([z.string(), z.number()]).optional().nullable(),
});

export const EmployeeUpdateSchema = EmployeeSelfUpdateSchema.extend({
  email: z.string().email().optional().nullable(),
  salary_ctc: z.union([z.string(), z.number()]).optional().nullable(),
  job_title: z.string().optional().nullable(),
  department: z.string().optional().nullable(),
  employment_type: z.string().optional().nullable(),
  report_required: z.boolean().optional().nullable(),
  reporting_manager_id: z.union([z.string(), z.number()]).optional().nullable(),
  date_of_joining: z.string().optional().nullable(),
  background_education: z.string().optional().nullable(),
  branch_id: z.union([z.string(), z.number()]).optional().nullable(),
  status: z.string().optional().nullable(),
  attendance_required: z.boolean().optional().nullable(),
  role_name: z.string().optional().nullable(),
});

export const EmployeeRolesUpdateSchema = z.object({
  role_names: z.array(z.string()).min(1, 'At least one role is required')
});

