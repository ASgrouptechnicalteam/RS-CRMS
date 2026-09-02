"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const logger_1 = require("./utils/logger");
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const cookie_parser_1 = __importDefault(require("cookie-parser"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const prisma_1 = require("./lib/prisma");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const shared_1 = require("./shared");
const health_1 = __importDefault(require("./routes/health"));
const auth_1 = __importDefault(require("./routes/auth"));
const attendance_1 = __importDefault(require("./routes/attendance"));
const md_1 = __importDefault(require("./routes/md"));
const reports_1 = __importDefault(require("./routes/reports"));
const tasks_1 = __importDefault(require("./routes/tasks"));
const performance_1 = __importDefault(require("./routes/performance"));
const notifications_1 = __importDefault(require("./routes/notifications"));
const targets_1 = __importDefault(require("./routes/targets"));
const employees_1 = __importDefault(require("./routes/employees"));
const leads_1 = __importDefault(require("./routes/leads"));
const properties_1 = __importDefault(require("./routes/properties"));
const opportunities_1 = __importDefault(require("./routes/opportunities"));
const installment_routes_1 = __importDefault(require("./routes/installment.routes"));
const projects_1 = __importDefault(require("./routes/projects"));
const kiosk_auth_1 = __importDefault(require("./routes/kiosk-auth"));
const siteVisits_1 = __importDefault(require("./routes/siteVisits"));
const customers_1 = __importDefault(require("./routes/customers"));
const public_1 = __importDefault(require("./routes/public"));
const admin_1 = __importDefault(require("./routes/admin"));
const expenseRefunds_1 = __importDefault(require("./routes/expenseRefunds"));
const pushSubscriptions_1 = __importDefault(require("./routes/pushSubscriptions"));
const announcement_1 = __importDefault(require("./routes/announcement"));
const booking_routes_1 = __importDefault(require("./routes/booking.routes"));
const payment_routes_1 = __importDefault(require("./routes/payment.routes"));
const integration_routes_1 = __importDefault(require("./routes/integration.routes"));
const complaint_routes_1 = __importDefault(require("./routes/complaint.routes"));
const analytics_1 = __importDefault(require("./routes/analytics"));
const aiSearch_1 = __importDefault(require("./routes/aiSearch"));
const messageTemplates_1 = __importDefault(require("./routes/messageTemplates"));
const pm_routing_1 = __importDefault(require("./routes/pm-routing"));
const whatsapp_1 = __importDefault(require("./routes/whatsapp"));
const roles_1 = __importDefault(require("./routes/roles"));
const portalWorker_1 = require("./services/portalWorker");
const compression_1 = __importDefault(require("compression"));
const app = (0, express_1.default)();
const port = process.env.PORT || 3000;
const p = prisma_1.prisma;
// Proxy Awareness for Rate Limiting (Render architecture)
app.set('trust proxy', 1);
// Security Middlewares
app.use((0, helmet_1.default)({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
const allowedOrigins = [
    'http://localhost:5173',
    'http://localhost:4173',
    'https://rscrm.radharealhomeproperties.com'
];
if (process.env.APP_URL && !allowedOrigins.includes(process.env.APP_URL)) {
    allowedOrigins.push(process.env.APP_URL);
}
app.use((0, cors_1.default)({ origin: allowedOrigins, credentials: true }));
app.use((0, cookie_parser_1.default)());
app.use((0, compression_1.default)({ threshold: 0 }));
// Body Parser
app.use(express_1.default.json());
// Enforce max pagination cap of 100 globally
const pagination_1 = require("./middleware/pagination");
app.use(pagination_1.enforceMaxPagination);
const swagger_1 = require("./utils/swagger");
(0, swagger_1.setupSwagger)(app);
const rateLimiter_1 = require("./middleware/rateLimiter");
app.use(rateLimiter_1.apiRateLimiter);
// Serve property and profile images publicly.
const uploadDir = process.env.UPLOAD_DIR || path_1.default.join(process.cwd(), 'uploads');
const propertiesDir = path_1.default.join(uploadDir, 'properties');
const profilesDir = path_1.default.join(uploadDir, 'profiles');
const expenseProofsDir = path_1.default.join(uploadDir, 'expense-proofs');
if (!fs_1.default.existsSync(propertiesDir))
    fs_1.default.mkdirSync(propertiesDir, { recursive: true });
if (!fs_1.default.existsSync(profilesDir))
    fs_1.default.mkdirSync(profilesDir, { recursive: true });
if (!fs_1.default.existsSync(expenseProofsDir))
    fs_1.default.mkdirSync(expenseProofsDir, { recursive: true });
app.use('/uploads/properties', express_1.default.static(propertiesDir));
app.use('/uploads/profiles', express_1.default.static(profilesDir));
app.use('/uploads/expense-proofs', express_1.default.static(expenseProofsDir));
// Global API Rate Limiter
app.use('/api/', rateLimiter_1.apiRateLimiter);
// Routes
app.use('/api/v1/health', health_1.default);
app.use('/api/v1/auth', auth_1.default);
app.use('/api/v1/kiosk-auth', kiosk_auth_1.default);
app.use('/api/v1/kiosk-credentials', kiosk_auth_1.default);
app.use('/api/v1/attendance', attendance_1.default);
app.use('/api/v1/md', md_1.default);
app.use('/api/v1/reports', reports_1.default);
app.use('/api/v1/tasks', tasks_1.default);
app.use('/api/v1/performance', performance_1.default);
app.use('/api/v1/notifications', notifications_1.default);
app.use('/api/v1/targets', targets_1.default);
app.use('/api/v1/employees', employees_1.default);
app.use('/api/v1/leads', leads_1.default);
app.use('/api/v1/customers', customers_1.default);
app.use('/api/v1/properties', properties_1.default);
app.use('/api/v1/opportunities', opportunities_1.default);
app.use('/api/v1/installments', installment_routes_1.default);
app.use('/api/v1/projects', projects_1.default);
app.use('/api/v1/site-visits', siteVisits_1.default);
app.use('/api/v1/public', public_1.default);
app.use('/api/v1/admin', admin_1.default);
app.use('/api/v1/expense-refunds', expenseRefunds_1.default);
app.use('/api/v1/push', pushSubscriptions_1.default);
app.use('/api/v1/announcement', announcement_1.default);
app.use('/api/v1/bookings', booking_routes_1.default);
app.use('/api/v1/payments', payment_routes_1.default);
app.use('/api/v1/integration', integration_routes_1.default);
app.use('/api/v1/complaints', complaint_routes_1.default);
app.use('/api/v1/analytics', analytics_1.default);
app.use('/api/v1/ai', aiSearch_1.default);
app.use('/api/v1/message-templates', messageTemplates_1.default);
app.use('/api/v1/pm-routing', pm_routing_1.default);
app.use('/api/v1/whatsapp', whatsapp_1.default);
app.use('/api/v1/roles', roles_1.default);
// =========================================
// NEW NAMESPACE ROUTING (Phase 1 Migration)
// =========================================
const internalRouter = express_1.default.Router();
internalRouter.use('/health', health_1.default);
internalRouter.use('/auth', auth_1.default);
internalRouter.use('/kiosk-auth', kiosk_auth_1.default);
internalRouter.use('/kiosk-credentials', kiosk_auth_1.default);
internalRouter.use('/attendance', attendance_1.default);
internalRouter.use('/md', md_1.default);
internalRouter.use('/reports', reports_1.default);
internalRouter.use('/tasks', tasks_1.default);
internalRouter.use('/performance', performance_1.default);
internalRouter.use('/notifications', notifications_1.default);
internalRouter.use('/targets', targets_1.default);
internalRouter.use('/employees', employees_1.default);
internalRouter.use('/leads', leads_1.default);
internalRouter.use('/customers', customers_1.default);
internalRouter.use('/properties', properties_1.default);
internalRouter.use('/opportunities', opportunities_1.default);
internalRouter.use('/installments', installment_routes_1.default);
internalRouter.use('/projects', projects_1.default);
internalRouter.use('/site-visits', siteVisits_1.default);
internalRouter.use('/admin', admin_1.default);
internalRouter.use('/expense-refunds', expenseRefunds_1.default);
internalRouter.use('/push', pushSubscriptions_1.default);
internalRouter.use('/announcement', announcement_1.default);
internalRouter.use('/bookings', booking_routes_1.default);
internalRouter.use('/payments', payment_routes_1.default);
internalRouter.use('/integration', integration_routes_1.default);
internalRouter.use('/complaints', complaint_routes_1.default);
internalRouter.use('/analytics', analytics_1.default);
internalRouter.use('/ai', aiSearch_1.default);
internalRouter.use('/message-templates', messageTemplates_1.default);
internalRouter.use('/pm-routing', pm_routing_1.default);
internalRouter.use('/whatsapp', whatsapp_1.default);
internalRouter.use('/roles', roles_1.default);
app.use('/api/v1/internal', internalRouter);
// Note: publicRoutes is already mounted at /api/v1/public above
// =========================================
// Fallback for unknown API routes
app.all('/api/*', (req, res) => {
    res.status(404).json({ error: 'API route not found' });
});
// Serve frontend static files from apps/web/dist
app.use(express_1.default.static(path_1.default.join(process.cwd(), 'apps/web/dist')));
// Handle React routing or return basic API status if static files don't exist
app.get('*', (req, res) => {
    const indexPath = path_1.default.join(process.cwd(), 'apps/web/dist/index.html');
    if (fs_1.default.existsSync(indexPath)) {
        res.sendFile(indexPath);
    }
    else {
        res.status(200).json({ status: 'API is running', message: 'Frontend is hosted separately.' });
    }
});
// Global Error Handler
app.use((err, req, res, next) => {
    if (err && (err.name === 'AppError' || err.statusCode || err.status)) {
        return res.status(err.statusCode || err.status || 400).json({ error: err.message });
    }
    if (err && err.name === 'ZodError') {
        return res.status(400).json({ error: 'Validation failed', details: err.errors });
    }
    // 3. Prisma Errors
    if (err && err.name === 'PrismaClientKnownRequestError') {
        logger_1.logger.error('PKE:', err);
        if (err.code === 'P2002')
            return res.status(409).json({ error: 'Conflict' });
        if (err.code === 'P2003')
            return res.status(400).json({ error: 'Invalid request' });
        if (err.code === 'P2025')
            return res.status(404).json({ error: 'Not found' });
        return res.status(400).json({ error: 'Invalid request' });
    }
    if (err && err.name === 'PrismaClientValidationError') {
        logger_1.logger.error('PVE:', err.message);
        return res.status(400).json({ error: 'Invalid request' });
    }
    logger_1.logger.error(err.stack);
    res.status(500).json({ error: 'Internal Server Error' });
});
// Auto-seed Hostinger MySQL Database on startup if empty
const bootstrapHostingerDatabase = async () => {
    try {
        const company = await p.company.upsert({
            where: { code: 'RRH' },
            update: { name: 'Radha Real Homes' },
            create: { name: 'Radha Real Homes', code: 'RRH', property_type_group: 'RADHA_REAL_HOMES' },
        });
        const mainBranch = (await p.branch.findFirst({ where: { company_id: company.id, name: 'Miyapur (Main Branch)' } })) ||
            (await p.branch.create({ data: { company_id: company.id, name: 'Miyapur (Main Branch)' } }));
        const secondaryBranch = (await p.branch.findFirst({ where: { company_id: company.id, name: 'Tarnaka Branch' } })) ||
            (await p.branch.create({ data: { company_id: company.id, name: 'Tarnaka Branch' } }));
        const rolesToSeed = [
            { name: shared_1.Roles.MD, is_system: true, is_invisible: false },
            { name: shared_1.Roles.ADMIN, is_system: true, is_invisible: true },
            { name: shared_1.Roles.HR_MANAGER, is_system: false, is_invisible: false },
            { name: shared_1.Roles.MARKETING_DIRECTOR, is_system: false, is_invisible: false },
            { name: shared_1.Roles.PROJECT_MANAGER, is_system: false, is_invisible: false },
            { name: shared_1.Roles.DIGITAL_LEAD_OPERATOR, is_system: false, is_invisible: false },
            { name: shared_1.Roles.TELECALLER, is_system: false, is_invisible: false },
            { name: shared_1.Roles.DIGITAL_MARKETING_HEAD, is_system: false, is_invisible: false },
            { name: shared_1.Roles.FINANCE, is_system: false, is_invisible: false },
            { name: shared_1.Roles.AGENT, is_system: false, is_invisible: false },
            { name: shared_1.Roles.DIGITAL_MARKETING_EXECUTIVE, is_system: false, is_invisible: false },
        ];
        const roleMap = {};
        for (const rDef of rolesToSeed) {
            const role = await p.role.upsert({
                where: { name: rDef.name },
                update: { is_invisible: rDef.is_invisible, is_system: rDef.is_system },
                create: rDef,
            });
            roleMap[rDef.name] = role;
        }
        const empCount = await p.employee.count();
        if (empCount > 0) {
            logger_1.logger.info(`[database]: Connected to Hostinger MySQL (${empCount} active employee records loaded)`);
            return;
        }
        logger_1.logger.info('[database]: Seeding Hostinger MySQL database with full team roster...');
        const defaultPassword = process.env.DEFAULT_ADMIN_PASSWORD;
        if (!defaultPassword) {
            if (process.env.NODE_ENV === 'production') {
                throw new Error('FATAL: DEFAULT_ADMIN_PASSWORD must be provided in production for initial bootstrap.');
            }
            logger_1.logger.warn('WARNING: Using insecure default admin password for development bootstrap.');
        }
        const passwordHash = await bcryptjs_1.default.hash(defaultPassword || 'Radhareal@123', 12);
        const initialEmployees = [
            {
                roleName: shared_1.Roles.ADMIN,
                code: 'RRH-ADMIN-001',
                name: 'Technical Admin',
                phone: '+91 99999 00001',
                email: 'admin@radharealhomes.com',
                dept: 'IT Systems',
                title: 'System Technical Admin',
                salary: 120000,
                exempt: true,
                branchId: mainBranch.id
            }
        ];
        for (const empDef of initialEmployees) {
            await p.employee.create({
                data: {
                    employee_code: empDef.code,
                    full_name: empDef.name,
                    phone: empDef.phone,
                    email: empDef.email,
                    company_id: company.id,
                    branch_id: empDef.branchId,
                    password_hash: passwordHash,
                    status: 'ACTIVE',
                    attendance_required: !empDef.exempt,
                    first_login_done: true,
                    job_title: empDef.title,
                    department: empDef.dept,
                    employment_type: 'FULL_TIME',
                    report_required: true,
                    salary_ctc: empDef.salary,
                    current_address: 'Flat 402, Royal Residency, Miyapur, Hyderabad, TS - 500049',
                    permanent_address: 'Plot 88, Green Meadows, Hyderabad, TS - 500081',
                    blood_group: 'O+',
                    pan_number: `${empDef.code.substring(4, 7)}DE1234F`,
                    aadhaar_number: '123456789012',
                    bank_name: 'HDFC Bank',
                    bank_account_number: '5010023456789',
                    bank_ifsc: 'HDFC0001234',
                    bank_branch: 'Miyapur Main',
                    emergency_contact_name: 'Emergency Contact',
                    emergency_contact_relation: 'Spouse',
                    emergency_contact_phone: '+91 99887 76600',
                    background_education: 'B.Tech / MBA (First Class)',
                    date_of_joining: new Date('2024-01-15T00:00:00.000Z'),
                    roles: {
                        create: { role_id: roleMap[empDef.roleName].id },
                    },
                },
            });
        }
        logger_1.logger.info('[database]: Hostinger MySQL database seeded successfully on startup!');
    }
    catch (err) {
        logger_1.logger.error('[database error]:', err.message);
    }
};
// Ensure required JWT secrets are present before starting
if (process.env.NODE_ENV === 'production') {
    if (!process.env.JWT_ACCESS_SECRET || process.env.JWT_ACCESS_SECRET.length < 32) {
        logger_1.logger.warn('WARNING: JWT_ACCESS_SECRET is missing or too short for production.');
    }
    if (!process.env.JWT_REFRESH_SECRET || process.env.JWT_REFRESH_SECRET.length < 32) {
        logger_1.logger.warn('WARNING: JWT_REFRESH_SECRET is missing or too short for production.');
    }
    if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length < 32) {
        logger_1.logger.warn('WARNING: ENCRYPTION_KEY is missing or too short for production. KYC data cannot be encrypted safely.');
    }
    if (!process.env.QR_HMAC_SECRET || process.env.QR_HMAC_SECRET.length < 32) {
        logger_1.logger.warn('WARNING: QR_HMAC_SECRET is missing or too short for production. Kiosk QR codes cannot be securely signed.');
    }
}
const scheduler_1 = require("./jobs/scheduler");
if (process.env.NODE_ENV !== 'test') {
    app.listen(port, () => {
        logger_1.logger.info(`[server]: API running at http://localhost:${port}`);
        // Initialize background jobs
        (0, scheduler_1.initJobs)();
        bootstrapHostingerDatabase();
        // Portal worker is DISABLED by default (PORTAL_WORKER_ENABLED=false).
        // Enable explicitly when the Customer Portal is available.
        portalWorker_1.PortalWorker.start();
    });
}
exports.default = app;
