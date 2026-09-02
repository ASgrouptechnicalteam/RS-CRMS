"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const prisma_1 = require("../lib/prisma");
const auth_1 = require("../middleware/auth");
const qr_1 = require("../utils/qr");
const time_1 = require("../utils/time");
const shared_1 = require("../shared");
const validate_1 = require("../middleware/validate");
const notifyEmployee_1 = require("../utils/notifyEmployee");
const router = (0, express_1.Router)();
const p = prisma_1.prisma;
// GET /api/v1/attendance/my-qr - Generate personal HMAC QR payload
router.get('/my-qr', auth_1.authenticateToken, async (req, res) => {
    try {
        const employeeId = req.user.employeeId;
        const employeeCode = req.user.employeeCode;
        const version = 1;
        const signedToken = (0, qr_1.generateQrHmac)(employeeId, employeeCode, version);
        // Get latest active QR record or create new
        let qrRecord = await p.employeeQrCode.findFirst({
            where: { employee_id: employeeId },
            orderBy: { generated_at: 'desc' },
        });
        if (!qrRecord) {
            qrRecord = await p.employeeQrCode.create({
                data: {
                    employee_id: employeeId,
                    qr_token: signedToken,
                },
            });
        }
        return res.status(200).json({
            employeeId,
            employeeCode,
            version,
            signedToken,
            qrData: JSON.stringify({ employeeId, employeeCode, version, signedToken }),
        });
    }
    catch (error) {
        console.error('QR fetch error:', error);
        return res.status(500).json({ error: 'Failed to generate QR token' });
    }
});
// GET /api/v1/attendance/employee-qr/:id - Generate/fetch HMAC QR payload for a specific employee (Admin/HR)
router.get('/employee-qr/:id', auth_1.authenticateToken, (0, auth_1.requireRole)([shared_1.Roles.MD, shared_1.Roles.HR_MANAGER, shared_1.Roles.ADMIN]), async (req, res) => {
    try {
        const targetId = parseInt(req.params.id);
        if (isNaN(targetId))
            return res.status(400).json({ error: 'Invalid employee ID' });
        const employee = await p.employee.findUnique({ where: { id: targetId } });
        if (!employee)
            return res.status(404).json({ error: 'Employee not found' });
        const version = 1;
        const signedToken = (0, qr_1.generateQrHmac)(employee.id, employee.employee_code, version);
        let qrRecord = await p.employeeQrCode.findFirst({
            where: { employee_id: employee.id },
            orderBy: { generated_at: 'desc' },
        });
        if (!qrRecord) {
            qrRecord = await p.employeeQrCode.create({
                data: { employee_id: employee.id, qr_token: signedToken },
            });
        }
        return res.status(200).json({
            employeeId: employee.id,
            employeeCode: employee.employee_code,
            version,
            signedToken,
            qrData: JSON.stringify({ employeeId: employee.id, employeeCode: employee.employee_code, version, signedToken }),
        });
    }
    catch (error) {
        console.error('Admin QR fetch error:', error);
        return res.status(500).json({ error: 'Failed to generate QR token' });
    }
});
// GET /api/v1/attendance/my-status - Check today's check-in status
router.get('/my-status', auth_1.authenticateToken, async (req, res) => {
    try {
        const employeeId = req.user.employeeId;
        const { dateString } = (0, time_1.getISTComponents)(new Date());
        // Find attendance log for today IST
        const logs = await p.attendanceLog.findMany({
            where: { employee_id: employeeId },
            orderBy: { check_in_at: 'desc' },
            take: 5,
        });
        const todayLog = logs.find((l) => {
            if (!l.check_in_at)
                return false;
            return (0, time_1.getISTComponents)(new Date(l.check_in_at)).dateString === dateString;
        });
        return res.status(200).json({
            date: dateString,
            checkedIn: !!todayLog,
            status: todayLog ? todayLog.status : null,
            checkInAt: todayLog?.check_in_at || null,
        });
    }
    catch (error) {
        return res.status(500).json({ error: 'Failed to fetch attendance status' });
    }
});
// Helper to parse and verify payload
const parseAndVerifyQR = (req, qrPayload) => {
    let payload = qrPayload;
    if (typeof qrPayload === 'string') {
        try {
            payload = JSON.parse(qrPayload);
        }
        catch (e) { }
    }
    if (!payload || !payload.employeeId)
        return null;
    const isValid = (0, qr_1.verifyQrHmac)(payload.employeeId, payload.employeeCode, payload.version || 1, payload.signedToken || payload);
    return isValid ? payload : null;
};
// POST /api/v1/attendance/scan - Verify QR and Stamp Attendance (IST rules)
// Kiosk-only: must be authenticated with a type:'KIOSK' token.
// The token's embedded branchId is written to AttendanceLog.branch_id so the
// attendance record carries the physical scan location, not the employee's
// assigned branch.
router.post('/scan', auth_1.authenticateKioskToken, async (req, res) => {
    const targetCompanyId = req.kiosk.companyId;
    const branchId = req.kiosk.branchId; // physical scan location
    try {
        const payload = parseAndVerifyQR(req, req.body.qrPayload);
        if (!payload)
            return res.status(400).json({ error: 'Invalid or forged QR Code token' });
        const targetEmployeeId = payload.employeeId;
        // Load employee and verify Tenant Isolation & Status
        const scannedEmployee = await p.employee.findUnique({
            where: { id: targetEmployeeId },
        });
        if (!scannedEmployee)
            return res.status(404).json({ error: 'Employee not found' });
        if (scannedEmployee.company_id !== targetCompanyId) {
            return res.status(403).json({ error: 'Employee does not belong to your company' });
        }
        if (scannedEmployee.status !== 'ACTIVE' || !scannedEmployee.attendance_required) {
            return res.status(403).json({ error: 'Employee is not eligible for attendance' });
        }
        const now = new Date();
        const { dateString, timeString } = (0, time_1.getISTComponents)(now);
        const istDate = new Date(`${dateString}T00:00:00+05:30`);
        if (istDate.getDay() === 0) {
            return res.status(400).json({ error: 'Today is a holiday, attendance cannot be stamped' });
        }
        const holidayCheck = await p.companyHoliday.findFirst({
            where: { company_id: targetCompanyId, date: istDate },
        });
        if (holidayCheck) {
            return res.status(400).json({ error: 'Today is a company holiday, attendance cannot be stamped' });
        }
        // Concurrency Protection via Transaction
        const result = await p.$transaction(async (tx) => {
            const existingLogs = await tx.attendanceLog.findMany({
                where: { employee_id: targetEmployeeId },
                orderBy: { check_in_at: 'desc' },
                take: 5,
            });
            const activeCheckIn = existingLogs.find((l) => l.check_out_at === null);
            if (activeCheckIn)
                return { alreadyStamped: true, log: activeCheckIn };
            const alreadyCheckedInToday = existingLogs.find((l) => {
                if (!l.check_in_at)
                    return false;
                return (0, time_1.getISTComponents)(new Date(l.check_in_at)).dateString === dateString;
            });
            if (alreadyCheckedInToday)
                return { alreadyStamped: true, log: alreadyCheckedInToday };
            // Check for an approved late-checkin proposal covering today (IST)
            const istTodayStart = new Date(`${dateString}T00:00:00+05:30`);
            const istTodayEnd = new Date(`${dateString}T23:59:59+05:30`);
            const approvedProposal = await tx.attendanceProposal.findFirst({
                where: {
                    employee_id: targetEmployeeId,
                    type: 'LATE_CHECKIN',
                    status: 'APPROVED',
                    target_date: { gte: istTodayStart, lte: istTodayEnd },
                },
            });
            const hasApprovedProposal = !!approvedProposal;
            const calculatedStatus = (0, time_1.calculateAttendanceStatus)(now, hasApprovedProposal, scannedEmployee.employment_type || 'FULL_TIME');
            const newLog = await tx.attendanceLog.create({
                data: {
                    employee_id: targetEmployeeId,
                    check_in_at: now,
                    status: calculatedStatus,
                    source: 'QR_SCAN',
                    ...(branchId != null ? { branch_id: branchId } : {}), // populate only for kiosk scans
                },
            });
            return { alreadyStamped: false, log: newLog };
        }, { isolationLevel: 'Serializable' });
        if (result.alreadyStamped) {
            return res.status(200).json({
                message: 'Already logged in for today',
                alreadyStamped: true,
                status: result.log?.status,
                checkInAt: result.log?.check_in_at,
                timeIST: timeString,
                full_name: scannedEmployee.full_name,
            });
        }
        return res.status(200).json({
            message: `Login stamped successfully as ${result.log?.status}`,
            alreadyStamped: false,
            status: result.log?.status,
            checkInAt: result.log?.check_in_at,
            timeIST: timeString,
            full_name: scannedEmployee.full_name,
        });
    }
    catch (error) {
        if (error.code === 'P2034') {
            // Transaction conflict / deadlock. Another request won the race.
            // We can safely assume they are already logged in.
            return res.status(200).json({
                message: 'Already logged in (handled concurrent request)',
                alreadyStamped: true,
                status: 'PRESENT',
                timeIST: (0, time_1.getISTComponents)(new Date()).timeString,
            });
        }
        console.error('Scan attendance error:', error);
        return res.status(500).json({ error: 'Attendance scan verification failed' });
    }
});
// POST /api/v1/attendance/checkout - Verify QR and Stamp Checkout
// Kiosk-only: must be authenticated with a type:'KIOSK' token.
// branch_id from the kiosk token is written to AttendanceLog so the checkout
// record carries the physical scan location.
router.post('/checkout', auth_1.authenticateKioskToken, async (req, res) => {
    const targetCompanyId = req.kiosk.companyId;
    const branchId = req.kiosk.branchId;
    try {
        const payload = parseAndVerifyQR(req, req.body.qrPayload);
        if (!payload)
            return res.status(400).json({ error: 'Invalid or forged QR Code token' });
        const targetEmployeeId = payload.employeeId;
        const scannedEmployee = await p.employee.findUnique({ where: { id: targetEmployeeId } });
        if (!scannedEmployee || scannedEmployee.company_id !== targetCompanyId) {
            return res.status(403).json({ error: 'Employee does not belong to your company' });
        }
        const now = new Date();
        const { dateString, timeString } = (0, time_1.getISTComponents)(now);
        const istDate = new Date(`${dateString}T00:00:00+05:30`);
        if (istDate.getDay() === 0) {
            return res.status(400).json({ error: 'Today is a holiday, attendance cannot be stamped' });
        }
        const holidayCheck = await p.companyHoliday.findFirst({
            where: { company_id: targetCompanyId, date: istDate },
        });
        if (holidayCheck) {
            return res.status(400).json({ error: 'Today is a company holiday, attendance cannot be stamped' });
        }
        if (timeString < '18:00:00') {
            // Check for approved early logout proposal
            const earlyProposal = await p.attendanceProposal.findFirst({
                where: {
                    employee_id: targetEmployeeId,
                    type: 'EARLY_CHECKOUT',
                    status: 'APPROVED',
                    target_date: {
                        gte: new Date(`${dateString}T00:00:00.000Z`),
                        lte: new Date(`${dateString}T23:59:59.999Z`),
                    }
                }
            });
            if (!earlyProposal) {
                return res.status(400).json({ error: 'Logout is not allowed before 18:00 IST without an emergency request' });
            }
        }
        // Kiosk logout gate: employees with report_required=true must submit today's
        // daily report before checking out. Reuses the same lookup logic as GET /reports/today-status.
        if (scannedEmployee.report_required) {
            const todayReport = await p.dailyReport.findFirst({
                where: {
                    employee_id: targetEmployeeId,
                    submitted_at: {
                        gte: new Date(`${dateString}T00:00:00.000Z`),
                        lte: new Date(`${dateString}T23:59:59.999Z`),
                    },
                },
            });
            if (!todayReport) {
                return res.status(400).json({
                    error: "Please submit today's daily report before logging out. Go to your account, submit the report, then come back and scan out.",
                });
            }
        }
        const result = await p.$transaction(async (tx) => {
            // Find active check-in
            const activeLog = await tx.attendanceLog.findFirst({
                where: { employee_id: targetEmployeeId, check_out_at: null },
                orderBy: { check_in_at: 'desc' },
            });
            if (!activeLog)
                return { error: 'No active check-in found for today' };
            const checkInTime = new Date(activeLog.check_in_at).getTime();
            const diffMs = now.getTime() - checkInTime;
            const durationMinutes = Math.max(0, Math.round(diffMs / 60000));
            const updatedLog = await tx.attendanceLog.update({
                where: { id: activeLog.id },
                data: {
                    check_out_at: now,
                    working_duration_minutes: durationMinutes,
                    ...(branchId != null ? { branch_id: branchId } : {}), // populate only for kiosk scans
                },
            });
            return { log: updatedLog };
        }, { isolationLevel: 'Serializable' });
        if (result.error)
            return res.status(400).json({ error: result.error });
        return res.status(200).json({
            message: 'Logged out successfully',
            checkOutAt: result.log?.check_out_at,
            working_duration_minutes: result.log?.working_duration_minutes,
            timeIST: timeString,
            full_name: scannedEmployee.full_name,
        });
    }
    catch (error) {
        console.error('Logout error:', error);
        return res.status(500).json({ error: 'Attendance logout failed' });
    }
});
// POST /api/v1/attendance/late-proposal - Submit late proposal (< 09:30 AM IST)
router.post('/late-proposal', auth_1.authenticateToken, (0, validate_1.validateRequestBody)(shared_1.LateProposalSchema), async (req, res) => {
    try {
        const { hours, minutes } = (0, time_1.getISTComponents)(new Date());
        const currentMinutes = hours * 60 + minutes;
        const cutoff930 = 9 * 60 + 30; // 09:30 AM
        if (currentMinutes > cutoff930) {
            return res.status(400).json({
                error: 'Late proposals must be submitted before 09:30 AM IST on the same day.',
            });
        }
        // Record proposal in AttendanceProposal table
        const proposal = await p.attendanceProposal.create({
            data: {
                employee_id: req.user.employeeId,
                type: 'LATE_CHECKIN',
                target_date: new Date(`${req.body.date}T${req.body.expected_time}:00+05:30`),
                reason: req.body.reason,
                status: 'PENDING',
            },
        });
        // Write AuditEvent so the HR approval queue (GET /attendance/proposals/queue)
        // can surface this submission — queue filters on action: 'SUBMIT_LATE_PROPOSAL'
        await p.auditEvent.create({
            data: {
                actor_id: req.user.employeeId,
                action: 'SUBMIT_LATE_PROPOSAL',
                entity_type: 'ATTENDANCE_PROPOSAL',
                entity_id: proposal.id,
                new_value: JSON.stringify({ type: 'LATE_CHECKIN', target_date: proposal.target_date, reason: req.body.reason }),
            },
        });
        return res.status(201).json({
            message: 'Late proposal submitted successfully to HR queue',
            proposalId: proposal.id,
        });
    }
    catch (error) {
        console.error('Late proposal error:', error);
        return res
            .status(500)
            .json({ error: 'Failed to submit late proposal', detail: error?.message });
    }
});
// POST /api/v1/attendance/leave-proposal - Submit leave proposal
router.post('/leave-proposal', auth_1.authenticateToken, async (req, res) => {
    try {
        const { start_date, end_date, reason } = req.body;
        if (!start_date || !reason) {
            return res.status(400).json({ error: 'Start date and reason are required' });
        }
        // Check if start_date is >= tomorrow
        const startDateObj = new Date(start_date);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        if (startDateObj <= today) {
            return res.status(400).json({
                error: 'Leave requests must be submitted at least 1 day in advance.',
            });
        }
        // Record proposal
        const proposal = await p.attendanceProposal.create({
            data: {
                employee_id: req.user.employeeId,
                type: 'LEAVE',
                target_date: new Date(`${start_date}T00:00:00+05:30`),
                reason: reason,
                status: 'PENDING',
            },
        });
        // Write AuditEvent so the HR approval queue can surface it
        await p.auditEvent.create({
            data: {
                actor_id: req.user.employeeId,
                action: 'SUBMIT_LEAVE_PROPOSAL',
                entity_type: 'ATTENDANCE_PROPOSAL',
                entity_id: proposal.id,
                new_value: JSON.stringify({ type: 'LEAVE', target_date: proposal.target_date, end_date, reason }),
            },
        });
        return res.status(201).json({
            message: 'Leave proposal submitted successfully to HR queue',
            proposalId: proposal.id,
        });
    }
    catch (error) {
        console.error('Leave proposal error:', error);
        return res
            .status(500)
            .json({ error: 'Failed to submit leave proposal', detail: error?.message });
    }
});
// POST /api/v1/attendance/early-logout-proposal - Submit emergency early logout
router.post('/early-logout-proposal', auth_1.authenticateToken, (0, validate_1.validateRequestBody)(shared_1.LateProposalSchema), // Reusing LateProposalSchema since it has date, expected_time, reason
async (req, res) => {
    try {
        // Record proposal in AttendanceProposal table
        const proposal = await p.attendanceProposal.create({
            data: {
                employee_id: req.user.employeeId,
                type: 'EARLY_CHECKOUT',
                target_date: new Date(`${req.body.date}T${req.body.expected_time}:00+05:30`),
                reason: req.body.reason,
                status: 'APPROVED', // Auto-approved for emergencies
            },
        });
        // Write AuditEvent so HR sees it
        await p.auditEvent.create({
            data: {
                actor_id: req.user.employeeId,
                action: 'SUBMIT_EARLY_LOGOUT',
                entity_type: 'ATTENDANCE_PROPOSAL',
                entity_id: proposal.id,
                new_value: JSON.stringify({ type: 'EARLY_CHECKOUT', target_date: proposal.target_date, reason: req.body.reason }),
            },
        });
        return res.status(201).json({
            message: 'Emergency logout request recorded successfully. You may now scan out at the Kiosk.',
            proposalId: proposal.id,
        });
    }
    catch (error) {
        console.error('Early logout proposal error:', error);
        return res
            .status(500)
            .json({ error: 'Failed to submit emergency logout request', detail: error?.message });
    }
});
// GET /api/v1/attendance/proposals/queue - HR Manager approval queue
router.get('/proposals/queue', auth_1.authenticateToken, (0, auth_1.requireRole)([shared_1.Roles.HR_MANAGER, shared_1.Roles.MD, shared_1.Roles.ADMIN]), async (req, res) => {
    try {
        const companyEmployees = await p.employee.findMany({
            where: { company_id: req.user.companyId },
            select: { id: true, full_name: true, employee_code: true },
        });
        const proposals = await p.attendanceProposal.findMany({
            where: {
                employee_id: { in: companyEmployees.map((e) => e.id) },
                status: 'PENDING',
            },
            orderBy: { created_at: 'desc' },
        });
        const mappedProposals = proposals.map((proposal) => {
            const emp = companyEmployees.find((e) => e.id === proposal.employee_id);
            return {
                ...proposal,
                employee: emp,
            };
        });
        return res.status(200).json({ proposals: mappedProposals });
    }
    catch (error) {
        console.error('Proposal queue error:', error);
        return res.status(500).json({ error: 'Failed to load HR proposal queue' });
    }
});
// POST /api/v1/attendance/proposals/:id/approve - Approve proposal
router.post('/proposals/:id/approve', auth_1.authenticateToken, (0, auth_1.requireRole)([shared_1.Roles.HR_MANAGER, shared_1.Roles.MD, shared_1.Roles.ADMIN]), async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const proposal = await p.attendanceProposal.findUnique({ where: { id } });
        if (!proposal)
            return res.status(404).json({ error: 'Proposal not found' });
        const updated = await p.attendanceProposal.update({
            where: { id },
            data: {
                status: 'APPROVED',
                reviewed_by: req.user.employeeId,
                reviewed_at: new Date(),
            },
        });
        (0, notifyEmployee_1.notifyEmployee)(proposal.employee_id, {
            title: 'Proposal Approved',
            message: `Your ${proposal.type === 'LEAVE' ? 'leave' : 'late'} request for ${new Date(proposal.target_date).toLocaleDateString()} has been approved.`,
            type: 'SYSTEM',
            link: '/attendance',
        });
        return res.status(200).json({ message: 'Proposal approved', proposal: updated });
    }
    catch (error) {
        console.error('Proposal approve error:', error);
        return res.status(500).json({ error: 'Failed to approve proposal' });
    }
});
// POST /api/v1/attendance/proposals/:id/reject - Reject proposal
router.post('/proposals/:id/reject', auth_1.authenticateToken, (0, auth_1.requireRole)([shared_1.Roles.HR_MANAGER, shared_1.Roles.MD, shared_1.Roles.ADMIN]), async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const proposal = await p.attendanceProposal.findUnique({ where: { id } });
        if (!proposal)
            return res.status(404).json({ error: 'Proposal not found' });
        const updated = await p.attendanceProposal.update({
            where: { id },
            data: {
                status: 'REJECTED',
                reviewed_by: req.user.employeeId,
                reviewed_at: new Date(),
            },
        });
        (0, notifyEmployee_1.notifyEmployee)(proposal.employee_id, {
            title: 'Proposal Rejected',
            message: `Your ${proposal.type === 'LEAVE' ? 'leave' : 'late'} request for ${new Date(proposal.target_date).toLocaleDateString()} has been rejected.`,
            type: 'SYSTEM',
            link: '/attendance',
        });
        return res.status(200).json({ message: 'Proposal rejected', proposal: updated });
    }
    catch (error) {
        console.error('Proposal reject error:', error);
        return res.status(500).json({ error: 'Failed to reject proposal' });
    }
});
// GET /api/v1/attendance/proposals/my - Employee's own proposals
router.get('/proposals/my', auth_1.authenticateToken, async (req, res) => {
    try {
        const proposals = await p.attendanceProposal.findMany({
            where: { employee_id: req.user.employeeId },
            orderBy: { created_at: 'desc' },
            take: 20,
        });
        return res.status(200).json({ proposals });
    }
    catch (error) {
        console.error('My proposals error:', error);
        return res.status(500).json({ error: 'Failed to load my proposals' });
    }
});
// GET /api/v1/attendance/live - HR Live Attendance Feed (Today only)
router.get('/live', auth_1.authenticateToken, (0, auth_1.requireRole)([shared_1.Roles.HR_MANAGER, shared_1.Roles.MD, shared_1.Roles.ADMIN]), async (req, res) => {
    try {
        const { dateString } = (0, time_1.getISTComponents)(new Date());
        // Fetch all attendance logs that occurred today
        const allLogs = await p.attendanceLog.findMany({
            where: { employee: { company_id: req.user.companyId } },
            orderBy: { check_in_at: 'desc' },
            include: {
                employee: {
                    select: {
                        full_name: true,
                        employee_code: true,
                    },
                },
            },
        });
        // Filter for today in IST
        const todayLogs = allLogs.filter((l) => {
            if (!l.check_in_at)
                return false;
            return (0, time_1.getISTComponents)(new Date(l.check_in_at)).dateString === dateString;
        });
        return res.status(200).json({ logs: todayLogs });
    }
    catch (error) {
        console.error('Live attendance error:', error);
        return res.status(500).json({ error: 'Failed to load live attendance' });
    }
});
// GET /api/v1/attendance/history - HR Paginated Historical Attendance
router.get('/history', auth_1.authenticateToken, (0, auth_1.requireRole)([shared_1.Roles.HR_MANAGER, shared_1.Roles.MD, shared_1.Roles.ADMIN]), async (req, res) => {
    try {
        const { search, status, startDate, endDate, page = '1', limit = '50' } = req.query;
        const skip = (Number(page) - 1) * Number(limit);
        const whereClause = {
            employee: {
                company_id: req.user.companyId,
                ...(search && {
                    OR: [
                        { full_name: { contains: search } },
                        { employee_code: { contains: search } },
                    ],
                }),
            },
        };
        if (status) {
            whereClause.status = status;
        }
        if (startDate || endDate) {
            whereClause.check_in_at = {};
            if (startDate)
                whereClause.check_in_at.gte = new Date(startDate);
            if (endDate) {
                const end = new Date(endDate);
                end.setHours(23, 59, 59, 999);
                whereClause.check_in_at.lte = end;
            }
        }
        const [logs, total] = await Promise.all([
            p.attendanceLog.findMany({
                where: whereClause,
                orderBy: { check_in_at: 'desc' },
                skip,
                take: Number(limit),
                include: {
                    employee: {
                        select: {
                            full_name: true,
                            employee_code: true,
                        },
                    },
                },
            }),
            p.attendanceLog.count({ where: whereClause }),
        ]);
        return res.status(200).json({
            logs,
            pagination: {
                total,
                page: Number(page),
                limit: Number(limit),
                totalPages: Math.ceil(total / Number(limit)),
            },
        });
    }
    catch (error) {
        console.error('History attendance error:', error);
        return res.status(500).json({ error: 'Failed to load attendance history' });
    }
});
router.get('/holidays', auth_1.authenticateToken, async (req, res) => {
    try {
        const companyId = req.user.companyId;
        const year = Number(req.query.year) || new Date().getFullYear();
        const holidays = await p.companyHoliday.findMany({
            where: {
                company_id: companyId,
                date: {
                    gte: new Date(`${year}-01-01T00:00:00Z`),
                    lte: new Date(`${year}-12-31T23:59:59Z`),
                },
            },
            orderBy: { date: 'asc' },
        });
        return res.status(200).json({ holidays });
    }
    catch (err) {
        return res.status(500).json({ error: 'Failed to fetch holidays' });
    }
});
router.post('/holidays', auth_1.authenticateToken, (0, auth_1.requireRole)([shared_1.Roles.MD, shared_1.Roles.ADMIN, shared_1.Roles.HR_MANAGER]), async (req, res) => {
    try {
        const { name, date } = req.body;
        if (!name || !date)
            return res.status(400).json({ error: 'Name and date are required' });
        const companyId = req.user.companyId;
        const istDate = new Date(`${date}T00:00:00Z`); // Stored as db.Date
        const h = await p.companyHoliday.create({
            data: {
                company_id: companyId,
                name,
                date: istDate,
            },
        });
        return res.status(201).json({ holiday: h });
    }
    catch (err) {
        return res.status(500).json({ error: 'Failed to create holiday' });
    }
});
router.delete('/holidays/:id', auth_1.authenticateToken, (0, auth_1.requireRole)([shared_1.Roles.MD, shared_1.Roles.ADMIN, shared_1.Roles.HR_MANAGER]), async (req, res) => {
    try {
        const id = Number(req.params.id);
        const companyId = req.user.companyId;
        const h = await p.companyHoliday.findFirst({ where: { id, company_id: companyId } });
        if (!h)
            return res.status(404).json({ error: 'Holiday not found' });
        await p.companyHoliday.delete({ where: { id } });
        return res.status(200).json({ message: 'Deleted successfully' });
    }
    catch (err) {
        return res.status(500).json({ error: 'Failed to delete holiday' });
    }
});
router.get('/calendar', auth_1.authenticateToken, async (req, res) => {
    try {
        const year = Number(req.query.year);
        const month = Number(req.query.month);
        let targetEmployeeId = req.user.employeeId;
        if (req.query.employeeId) {
            const hrRoles = [shared_1.Roles.MD, shared_1.Roles.ADMIN, shared_1.Roles.HR_MANAGER];
            const isHR = req.user.roles?.some((r) => hrRoles.includes(r));
            if (!isHR)
                return res.status(403).json({ error: 'Not authorized to view other calendars' });
            targetEmployeeId = Number(req.query.employeeId);
        }
        if (!year || !month)
            return res.status(400).json({ error: 'year and month are required' });
        const startDate = new Date(`${year}-${month.toString().padStart(2, '0')}-01T00:00:00+05:30`);
        const endDate = new Date(startDate);
        endDate.setMonth(endDate.getMonth() + 1);
        const employee = await p.employee.findUnique({
            where: { id: targetEmployeeId },
            select: { created_at: true }
        });
        if (!employee)
            return res.status(404).json({ error: 'Employee not found' });
        const logs = await p.attendanceLog.findMany({
            where: {
                employee_id: targetEmployeeId,
                check_in_at: { gte: startDate, lt: endDate },
            },
            orderBy: { check_in_at: 'asc' },
        });
        const holidays = await p.companyHoliday.findMany({
            where: {
                company_id: req.user.companyId,
                date: { gte: startDate, lt: endDate },
            },
        });
        const proposals = await p.attendanceProposal.findMany({
            where: {
                employee_id: targetEmployeeId,
                type: { in: ['LATE_CHECKIN', 'LEAVE'] },
                status: 'APPROVED',
                target_date: { gte: startDate, lt: endDate },
            },
        });
        const calendarMap = {};
        const d = new Date(startDate);
        let totalLates = 0;
        let totalHalfDays = 0;
        const now = new Date();
        const { dateString: todayStr, hours: currentHour } = (0, time_1.getISTComponents)(now);
        while (d < endDate) {
            const dayStr = `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')}`;
            let defaultStatus = 'ABSENT';
            if (dayStr > todayStr) {
                defaultStatus = 'PENDING'; // Future dates
            }
            else if (dayStr === todayStr && currentHour < 18) {
                defaultStatus = 'PENDING'; // Today before 6 PM
            }
            calendarMap[dayStr] = { status: defaultStatus, log: null };
            if (d.getDay() === 0) {
                calendarMap[dayStr].status = 'HOLIDAY';
                calendarMap[dayStr].holidayName = 'Sunday';
            }
            d.setDate(d.getDate() + 1);
        }
        for (const h of holidays) {
            const hd = new Date(h.date);
            const dayStr = `${hd.getFullYear()}-${(hd.getMonth() + 1).toString().padStart(2, '0')}-${hd.getDate().toString().padStart(2, '0')}`;
            if (calendarMap[dayStr]) {
                calendarMap[dayStr].status = 'HOLIDAY';
                calendarMap[dayStr].holidayName = h.name;
            }
        }
        for (const p of proposals) {
            const pd = new Date(p.target_date);
            const dayStr = `${pd.getFullYear()}-${(pd.getMonth() + 1).toString().padStart(2, '0')}-${pd.getDate().toString().padStart(2, '0')}`;
            if (calendarMap[dayStr]) {
                if (p.type === 'LEAVE') {
                    calendarMap[dayStr].status = 'LEAVE';
                    calendarMap[dayStr].isLeave = true;
                }
                else if (p.type === 'LATE_CHECKIN') {
                    calendarMap[dayStr].hasApprovedLateProposal = true;
                }
            }
        }
        for (const l of logs) {
            const ld = new Date(l.check_in_at);
            const { dateString } = (0, time_1.getISTComponents)(ld);
            if (calendarMap[dateString]) {
                // If it was already marked as LEAVE from a proposal, we might still want to attach the log
                calendarMap[dateString].log = l;
                let adjustedStatus = l.status;
                if (calendarMap[dateString].hasApprovedLateProposal) {
                    adjustedStatus = 'PRESENT';
                }
                // If there's an actual punch, and they were on leave, maybe keep it as LEAVE or let the punch override?
                // Usually if they punch in, the punch status overrides. But let's check if it's LEAVE.
                if (calendarMap[dateString].isLeave) {
                    adjustedStatus = 'LEAVE';
                }
                calendarMap[dateString].status = adjustedStatus;
                if (adjustedStatus === 'LATE')
                    totalLates++;
                if (adjustedStatus === 'HALF_DAY')
                    totalHalfDays++;
            }
        }
        const penaltyAbsents = Math.floor(totalLates / 3) + Math.floor(totalHalfDays / 2);
        return res.status(200).json({ calendar: calendarMap, penaltyAbsents, employeeCreatedAt: employee.created_at });
    }
    catch (err) {
        console.error('Failed to generate calendar:', err);
        return res.status(500).json({ error: 'Failed to generate calendar' });
    }
});
exports.default = router;
