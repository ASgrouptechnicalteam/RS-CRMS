// SOPs by role (2026-11-08). One definition used by the API (the My Day
// checklist) and the web (SOPs by role, Help pages). Keep docs/SOP-BY-ROLE.md
// in step with this file by hand.
//
// These are guidance. They do not change a score or block anything by
// themselves. Where the text says something is blocked, the code does block it:
//   - logout and QR check-out wait for assigned calls and tomorrow's plan
//     (services/dayPlan.service.ts, getLogoutBlockers);
//   - QR check-out also waits for the end-of-day report, and for 18:00;
//   - nothing is judged on calls typed into the Work Log.
//
// Role keys are the values of Roles (auth.ts). tests/api/my-day-checklist.test.ts
// fails if a role has no SOP here or an SOP names a role that does not exist.

export type SopBlock = 'MORNING' | 'DURING' | 'BEFORE_LOGOUT';

/** What the API can work out from real data. An item without one is ticked by hand. */
export type SopAuto =
  | 'CHECKED_IN'
  | 'CHECKED_OUT'
  | 'CALLS_DONE'
  | 'FOLLOW_UPS_CLEARED'
  | 'TASKS_DONE'
  | 'PLAN_WRITTEN'
  | 'REPORT_SENT'
  | 'VISITS_UPDATED'
  | 'PM_VISITS_ACCEPTED'
  | 'PM_VERIFIED'
  | 'DM_POLISHED'
  | 'HR_QUEUE_CLEARED'
  | 'FINANCE_QUEUE_CLEARED'
  | 'APPROVALS_CLEARED';

export interface SopItem {
  /** Stable. Manual ticks are saved against it, so do not rename. */
  key: string;
  block: SopBlock;
  text: string;
  /** App page to open. */
  link?: string;
  auto?: SopAuto;
  /** Hidden for people who are not held to attendance or the daily report. */
  needs?: 'ATTENDANCE' | 'REPORT';
}

export interface RoleSop {
  role: string;
  title: string;
  summary: string;
  items: SopItem[];
  notes: string[];
}

const item = (
  block: SopBlock,
  key: string,
  text: string,
  link?: string,
  auto?: SopAuto,
  needs?: SopItem['needs'],
): SopItem => ({ key, block, text, link, auto, needs });

const M = 'MORNING' as const;
const D = 'DURING' as const;
const B = 'BEFORE_LOGOUT' as const;

// The same key in every role, so a person holding two roles sees each only once.
const CHECK_IN = item(
  M,
  'common.check_in',
  'Check in by 10:30 for full credit. Scan the office QR; on an approved work-from-home day, check in from the app.',
  '/my-attendance',
  'CHECKED_IN',
  'ATTENDANCE',
);
const TASKS = item(D, 'common.tasks', 'Finish the tasks due today.', '/tasks', 'TASKS_DONE');
const PLAN = item(
  B,
  'common.plan',
  "Save tomorrow's plan. Logout and QR check-out are blocked until it is saved.",
  '/my-day',
  'PLAN_WRITTEN',
  'ATTENDANCE',
);
const REPORT = item(
  B,
  'common.report',
  'Send your end-of-day report. QR check-out needs it.',
  '/my-day#report',
  'REPORT_SENT',
  'REPORT',
);
const CHECK_OUT = item(
  B,
  'common.check_out',
  'Scan the QR to check out, after 18:00. Leaving earlier needs an approved early-checkout request.',
  '/my-attendance',
  'CHECKED_OUT',
  'ATTENDANCE',
);
const WORK_LOG = item(
  D,
  'common.work_log',
  'Log work done outside the CRM in the Work Log as it happens, so the report starts from the record.',
  '/my-day',
);
const END = [PLAN, REPORT, CHECK_OUT];

const NOTE_COMMON =
  'Check-out is by QR scan only. If you stay signed in past midnight, the system checks you out at 23:58 and you lose a performance point.';
const NOTE_REPORT =
  'The report is checked against the CRM record. If a target is set for your role and you are below it, give the reason (at least 15 characters).';

export const SOP_BY_ROLE: Record<string, RoleSop> = {
  telecallers: {
    role: 'telecallers',
    title: 'Telecaller',
    summary: 'Call every lead handed to you, log each call, and clear follow-ups.',
    items: [
      CHECK_IN,
      item(
        M,
        'tc.list',
        'Open your calling list. Make the new calls first, then the follow-ups.',
        '/dashboard',
      ),
      item(
        D,
        'tc.calls',
        'Log a call on every lead assigned to you from master data. Logout and QR check-out are blocked until each has one.',
        '/dashboard',
        'CALLS_DONE',
      ),
      item(
        D,
        'tc.follow_ups',
        'Clear your follow-ups due: call-backs due today or earlier, and unanswered calls to try again.',
        '/dashboard',
        'FOLLOW_UPS_CLEARED',
      ),
      item(
        D,
        'tc.pipeline',
        'Move interested leads on (Contacted, Qualified) and book a site visit for qualified ones.',
        '/leads',
      ),
      item(
        D,
        'tc.transfer',
        'A lead you cannot work: open it and use Transfer to a colleague, with a reason.',
        '/leads',
      ),
      TASKS,
      ...END,
    ],
    notes: [
      'Only calls logged on the lead in the CRM count. Calls typed into the Work Log are not counted and not judged.',
      NOTE_REPORT,
      NOTE_COMMON,
    ],
  },
  'Sales manager': {
    role: 'Sales manager',
    title: 'Sales Manager',
    summary: 'Keep leads and site visits owned, and keep the team moving.',
    items: [
      CHECK_IN,
      item(M, 'sm.unowned', 'Look for leads with no owner and give each one an owner.', '/leads'),
      item(
        D,
        'sm.team',
        "Check your team's calls and targets. Chase anyone far behind.",
        '/team-performance',
      ),
      item(
        D,
        'sm.visits',
        "Check that today's and tomorrow's site visits each have someone to run them.",
        '/site-visits',
      ),
      item(
        D,
        'sm.stale',
        "Act on leads flagged for no activity in 5 days; the system sends them to the owner's reporting manager.",
        '/leads',
      ),
      TASKS,
      ...END,
    ],
    notes: [NOTE_REPORT, NOTE_COMMON],
  },
  Agent: {
    role: 'Agent',
    title: 'Agent',
    summary: 'Run the site visits given to you and record how each went.',
    items: [
      CHECK_IN,
      item(
        M,
        'ag.visits',
        "Read today's site visits and confirm each with the customer.",
        '/site-visits',
      ),
      item(
        D,
        'ag.update',
        'After each visit, mark it Completed and record the outcome.',
        '/site-visits',
        'VISITS_UPDATED',
      ),
      TASKS,
      ...END,
    ],
    notes: [NOTE_REPORT, NOTE_COMMON],
  },
  'project managers': {
    role: 'project managers',
    title: 'Project Manager',
    summary: 'Accept site visits, run them, and verify the properties assigned to you.',
    items: [
      CHECK_IN,
      item(
        M,
        'pm.accept',
        'Accept or decline every visit request waiting for you. A visit not accepted within 10 hours of its time goes to the MD.',
        '/approvals?tab=visits',
        'PM_VISITS_ACCEPTED',
      ),
      item(M, 'pm.prepare', 'For each visit today, open Prepare for visit.', '/site-visits'),
      item(D, 'pm.verify', 'Verify the properties assigned to you.', '/properties', 'PM_VERIFIED'),
      item(
        D,
        'pm.update',
        'After each visit, mark it Completed and record the outcome.',
        '/site-visits',
        'VISITS_UPDATED',
      ),
      item(
        D,
        'pm.issues',
        'Note site issues as they come up; they go in your report.',
        '/my-day#report',
      ),
      TASKS,
      ...END,
    ],
    notes: [NOTE_REPORT, NOTE_COMMON],
  },
  'Channel partner manager': {
    role: 'Channel partner manager',
    title: 'Channel Partner Manager',
    summary: 'Keep in touch with associates and log every contact.',
    items: [
      CHECK_IN,
      item(
        M,
        'cpm.associates',
        'Look at your associates and pick who to contact today, starting with those not contacted lately.',
        '/dashboard',
      ),
      item(
        D,
        'cpm.log',
        'Log each associate call, new prospect, office visit, enrollment, site visit and booking in the Work Log as it happens.',
        '/my-day',
      ),
      TASKS,
      ...END,
    ],
    notes: [
      'The CRM cannot see associate work, so only what you log appears in your report. Work Log numbers are shown in the report but are not judged against targets.',
      NOTE_COMMON,
    ],
  },
  HR: {
    role: 'HR',
    title: 'HR Manager',
    summary: 'Decide attendance requests, review check-in photos, and chase missing reports.',
    items: [
      CHECK_IN,
      item(
        M,
        'hr.queue',
        'Decide the attendance requests and review the check-in photos waiting.',
        '/approvals?tab=attendance',
        'HR_QUEUE_CLEARED',
      ),
      item(D, 'hr.today', 'Check who is in, late or absent today.', '/hr-attendance'),
      item(
        D,
        'hr.reports',
        'Read the daily reports and note who has not sent one.',
        '/hr-daily-reports',
      ),
      TASKS,
      ...END,
    ],
    notes: ['Your report has a typed field for interviews held; enter 0 if none.', NOTE_COMMON],
  },
  accountant: {
    role: 'accountant',
    title: 'Finance (Accountant)',
    summary: 'Verify customer payments and settle refunds.',
    items: [
      CHECK_IN,
      item(
        D,
        'fin.queue',
        'Verify the customer payments waiting and settle the refunds due.',
        '/finance',
        'FINANCE_QUEUE_CLEARED',
      ),
      item(D, 'fin.installments', 'Look at installments falling due soon.', '/finance'),
      TASKS,
      ...END,
    ],
    notes: [NOTE_COMMON],
  },
  'Digital lead operator': {
    role: 'Digital lead operator',
    title: 'Digital Lead Operator',
    summary: 'Bring in digital leads and get them to telecallers.',
    items: [
      CHECK_IN,
      item(D, 'dlo.add', 'Add the new digital leads and fix wrong or duplicate numbers.', '/leads'),
      item(D, 'dlo.assign', 'Assign the new leads to telecallers.', '/leads'),
      TASKS,
      ...END,
    ],
    notes: [NOTE_COMMON],
  },
  'Digital Marketing head(manager)': {
    role: 'Digital Marketing head(manager)',
    title: 'Digital Marketing Head',
    summary: 'Run the marketing work and polish listings before they go to the MD.',
    items: [
      CHECK_IN,
      item(
        M,
        'dmh.polish',
        'Polish the properties and projects waiting at your step.',
        '/properties',
        'DM_POLISHED',
      ),
      WORK_LOG,
      TASKS,
      ...END,
    ],
    notes: ['Your report has a typed ad spend field; enter 0 if nothing was spent.', NOTE_COMMON],
  },
  'digital marketing executive': {
    role: 'digital marketing executive',
    title: 'Digital Marketing Executive',
    summary: 'Post content and run campaigns, and log each one.',
    items: [CHECK_IN, WORK_LOG, TASKS, ...END],
    notes: ['Your report has a typed ad spend field; enter 0 if nothing was spent.', NOTE_COMMON],
  },
  'marketing director': {
    role: 'marketing director',
    title: 'Marketing Director',
    summary: 'Lead marketing and watch the visits escalated to you.',
    items: [
      CHECK_IN,
      item(M, 'mkd.escalated', 'Look at site visits escalated to you.', '/site-visits'),
      WORK_LOG,
      TASKS,
      ...END,
    ],
    notes: ['Your report has a typed ad spend field; enter 0 if nothing was spent.', NOTE_COMMON],
  },
  'Inventory Executive': {
    role: 'Inventory Executive',
    title: 'Inventory Executive',
    summary: 'Enter and correct projects and properties for the Project Manager.',
    items: [
      CHECK_IN,
      item(
        D,
        'inv.enter',
        'Enter or correct the projects, properties and units you were given. The Project Manager reviews them.',
        '/projects',
      ),
      TASKS,
      ...END,
    ],
    notes: [NOTE_COMMON],
  },
  'Data Entry Operator': {
    role: 'Data Entry Operator',
    title: 'Data Entry Operator',
    summary: 'Keep projects, properties, leads and customers complete and correct.',
    items: [
      CHECK_IN,
      item(
        D,
        'de.enter',
        'Enter or correct the projects, properties, leads and customer details you were given.',
        '/leads',
      ),
      TASKS,
      ...END,
    ],
    notes: [NOTE_COMMON],
  },
  Staff: {
    role: 'Staff',
    title: 'Staff',
    summary: 'Do the work your manager gives you.',
    items: [CHECK_IN, TASKS, ...END],
    notes: [NOTE_COMMON],
  },
  'Technical Manager': {
    role: 'Technical Manager',
    title: 'Technical Manager',
    summary: "Keep the system healthy and hand out the day's master data leads.",
    items: [
      CHECK_IN,
      item(
        M,
        'tm.dashboard',
        'Open the dashboard and go through Needs attention first.',
        '/dashboard',
      ),
      item(M, 'tm.master', "Assign the day's master data leads to telecallers.", '/master-data'),
      item(
        D,
        'tm.return',
        'Take untouched leads back to master data when a telecaller cannot work them.',
        '/master-data',
      ),
      item(D, 'tm.access', 'Handle access, role and sign-in requests.', '/access-control'),
      TASKS,
      ...END,
    ],
    notes: [
      'You follow attendance and send a daily report like any employee, even though you have Admin access.',
      NOTE_COMMON,
    ],
  },
  'Managing director': {
    role: 'Managing director',
    title: 'Managing Director',
    summary: 'Clear what is waiting for your decision and watch the team.',
    items: [
      item(
        M,
        'md.approvals',
        'Clear what is waiting in Approvals: bookings, properties, projects, refunds and attendance requests.',
        '/approvals',
        'APPROVALS_CLEARED',
      ),
      item(D, 'md.visits', 'Look at site visits escalated to you.', '/site-visits'),
      item(D, 'md.team', 'Open Team Today to see who is in and what they did.', '/team-today'),
      item(B, 'md.reports', "Skim today's daily reports.", '/hr-daily-reports'),
    ],
    notes: ['You are not held to check-in, the daily report or the logout checks.'],
  },
  'Admin (Technical)': {
    role: 'Admin (Technical)',
    title: 'Admin (Technical)',
    summary: 'Look after accounts, access and devices.',
    items: [
      item(M, 'adm.dashboard', 'Open the dashboard and look for problems.', '/dashboard'),
      item(D, 'adm.access', 'Handle access, role and account requests.', '/access-control'),
      item(D, 'adm.devices', 'Check that the attendance kiosks are working.', '/kiosk-management'),
    ],
    notes: ['You are not held to check-in, the daily report or the logout checks.'],
  },
  // External channel partners (2026-11-15) use the partner app at /partner,
  // not My Day; this is what that app is for.
  'Channel partner (external)': {
    role: 'Channel partner (external)',
    title: 'Channel partner (external)',
    summary: 'Run the site visits given to you and send in new properties.',
    items: [
      item(
        M,
        'cpx.visits',
        'Open the channel partner app and look at your site visits for today.',
        '/partner',
      ),
      item(D, 'cpx.run', 'Run each visit and mark it done in the app.', '/partner'),
      item(D, 'cpx.property', 'Send any new property you find, with its details.', '/partner'),
    ],
    notes: ['You are not held to check-in, the daily report or the logout checks.'],
  },
};

export const SOP_ROLE_ORDER: string[] = [
  'Managing director',
  'Admin (Technical)',
  'Technical Manager',
  'marketing director',
  'project managers',
  'Digital lead operator',
  'telecallers',
  'Digital Marketing head(manager)',
  'HR',
  'accountant',
  'Agent',
  'digital marketing executive',
  'Sales manager',
  'Channel partner manager',
  'Staff',
  'Inventory Executive',
  'Data Entry Operator',
  'Channel partner (external)',
];

export const SOP_BLOCK_LABEL: Record<SopBlock, string> = {
  MORNING: 'Morning',
  DURING: 'During the day',
  BEFORE_LOGOUT: 'Before logout',
};

/** Who may read every role's SOP (the read-only SOPs by role page). */
export const canReadAllSops = (roles?: string[]): boolean =>
  !!roles?.some((r) => ['Managing director', 'HR', 'Technical Manager'].includes(r));
