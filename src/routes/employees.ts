import { logger } from '../utils/logger';
import { Router, Response } from 'express';
import { prisma } from '../lib/prisma';
import bcrypt from 'bcryptjs';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { requireAuthz } from '../middleware/authz';
import { 
  Roles, 
  DepartmentCodes, 
  Permissions,
  EmployeeSelfUpdateSchema,
  EmployeeCreateSchema,
  EmployeeUpdateSchema,
  EmployeeRolesUpdateSchema,
  EmptyBodySchema
} from '../shared';
import { can } from '../authz/authorization';
import { notifyEmployee } from '../utils/notifyEmployee';
import { encryptData } from '../utils/crypto';
import { buildEmployeeScope } from '../authz/dataScope';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { publicAssetUrl } from '../utils/media';
import { validateRequestBody } from '../middleware/validate';

const router = Router();

import { memoryUpload, getStorageService } from '../services/storage.service';

const profileUpload = memoryUpload;
// PATCH /api/v1/employees/me - Self-update for safe profile fields
router.patch('/me', authenticateToken, validateRequestBody(EmployeeSelfUpdateSchema), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const employeeId = req.user!.employeeId;
    const { 
      full_name, phone, secondary_phone, whatsapp_number, email, current_address, permanent_address, 
      emergency_contact_name, emergency_contact_relation, emergency_contact_phone, 
      blood_group, social_links,
      pan_number, aadhaar_number, bank_name, bank_account_number, bank_ifsc, bank_branch 
    } = req.body;

    const currentEmp = await prisma.employee.findUnique({
      where: { id: employeeId },
      select: { bank_account_number: true }
    });

    if (!currentEmp) {
      return res.status(404).json({ error: 'Employee not found' });
    }

    const updateData: any = {};
    if (full_name !== undefined) updateData.full_name = full_name;
    if (phone !== undefined) updateData.phone = phone;
    if (secondary_phone !== undefined) updateData.secondary_phone = secondary_phone;
    if (whatsapp_number !== undefined) updateData.whatsapp_number = whatsapp_number;
    if (email !== undefined) updateData.email = email;
    if (current_address !== undefined) updateData.current_address = current_address;
    if (permanent_address !== undefined) updateData.permanent_address = permanent_address;
    if (emergency_contact_name !== undefined) updateData.emergency_contact_name = emergency_contact_name;
    if (emergency_contact_relation !== undefined) updateData.emergency_contact_relation = emergency_contact_relation;
    if (emergency_contact_phone !== undefined) updateData.emergency_contact_phone = emergency_contact_phone;
    if (blood_group !== undefined) updateData.blood_group = blood_group;
    if (social_links !== undefined) updateData.social_links = social_links;
    
    // KYC
    if (pan_number !== undefined) updateData.pan_number = pan_number;
    if (aadhaar_number !== undefined) updateData.aadhaar_number = aadhaar_number;

    // Bank Details (always allow updating now)
    if (bank_name !== undefined) updateData.bank_name = bank_name;
    if (bank_account_number !== undefined) updateData.bank_account_number = bank_account_number;
    if (bank_ifsc !== undefined) updateData.bank_ifsc = bank_ifsc;
    if (bank_branch !== undefined) updateData.bank_branch = bank_branch;

    const updatedEmp = await prisma.employee.update({
      where: { id: employeeId },
      data: updateData,
      select: {
        id: true,
        full_name: true,
        phone: true,
        secondary_phone: true,
        whatsapp_number: true,
        email: true,
        blood_group: true,
        social_links: true,
        current_address: true,
        permanent_address: true,
        emergency_contact_name: true,
        emergency_contact_relation: true,
        emergency_contact_phone: true,
        pan_number: true,
        aadhaar_number: true,
        bank_name: true,
        bank_account_number: true,
        bank_ifsc: true,
        bank_branch: true,
        profile_image_url: true,
      }
    });

    return res.status(200).json({
      message: 'Profile updated successfully',
      employee: updatedEmp,
    });
  } catch (error) {
    logger.error('Self update error:', error);
    return res.status(500).json({ error: 'Failed to update profile' });
  }
});

// POST /api/v1/employees/me/photo - Upload profile photo
router.post('/me/photo', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  profileUpload.single('profile_image')(req, res, async (err: any) => {
    if (err) {
      logger.error('Multer error:', err);
      return res.status(400).json({ error: err.message || 'File upload failed' });
    }

    try {
      const file = req.file;
      if (!file) {
        return res.status(400).json({ error: 'No image file provided.' });
      }

      const employeeId = req.user!.employeeId;
      
      const emp = await prisma.employee.findUnique({ where: { id: employeeId }, select: { profile_image_url: true } });
      
      const storageService = getStorageService('profiles');
      const newImageUrl = await storageService.upload(file.buffer, file.originalname, file.mimetype);
      
      await prisma.employee.update({
        where: { id: employeeId },
        data: { profile_image_url: newImageUrl },
      });

      if (emp?.profile_image_url) {
        await storageService.delete(emp.profile_image_url).catch(e => logger.warn('Could not delete old profile photo:', e));
      }

      return res.status(200).json({
        message: 'Profile photo updated successfully',
        profile_image_url: publicAssetUrl(newImageUrl),
      });
    } catch (error) {
      logger.error('Profile photo upload error:', error);
      return res.status(500).json({ error: 'Failed to upload profile photo' });
    }
  });
});

// GET /api/v1/employees - List all active/inactive employees (Admin invisible filtered)
router.get('/', authenticateToken, requireAuthz(Permissions.EMPLOYEES_READ), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 100);
    const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);

    const whereClause = await buildEmployeeScope(req.user!);

    const employees = await prisma.employee.findMany({
      take: limit,
      skip: offset,
      where: whereClause,
      include: {
        branch: true,
        roles: { include: { role: true } },
      },
      orderBy: { created_at: 'desc' },
    });

    const formatted = employees.map((emp) => ({
      id: emp.id,
      employeeCode: emp.employee_code,
      fullName: emp.full_name || emp.employee_code,
      branchId: emp.branch_id,
      branch: emp.branch?.name || 'All Branches',
      status: emp.status,
      attendanceRequired: emp.attendance_required,
      firstLoginDone: emp.first_login_done,
      roles: emp.roles.map((r) => r.role.name),
      createdAt: emp.created_at,

      phone: emp.phone || '',
      secondaryPhone: emp.secondary_phone || '',
      whatsappNumber: emp.whatsapp_number || '',
      email: emp.email || '',
      bloodGroup: emp.blood_group || '',
      socialLinks: emp.social_links || '',
      currentAddress: emp.current_address || '',
      permanentAddress: emp.permanent_address || '',
      emergencyContactName: emp.emergency_contact_name || '',
      emergencyContactRelation: emp.emergency_contact_relation || '',
      emergencyContactPhone: emp.emergency_contact_phone || '',
      panNumber: emp.pan_number || '',
      aadhaarNumber: emp.aadhaar_number || '',
      bankName: emp.bank_name || '',
      bankAccountNumber: emp.bank_account_number || '',
      bankIfsc: emp.bank_ifsc || '',
      bankBranch: emp.bank_branch || '',
      jobTitle: emp.job_title || '',
      department: emp.department || '',
      employmentType: emp.employment_type || 'FULL_TIME',
      reportRequired: emp.report_required !== false,
      reportingManagerId: emp.reporting_manager_id,
      dateOfJoining: emp.date_of_joining ? emp.date_of_joining.toISOString().split('T')[0] : '',
      backgroundEducation: emp.background_education || '',
    }));

    // SENSITIVE DATA FILTERING (Stage 2)
    const canViewSensitive = can(req.user!, Permissions.EMPLOYEES_VIEW_SENSITIVE, { company_id: req.user!.companyId });
    if (!canViewSensitive) {
      formatted.forEach((emp: any) => {
        delete emp.panNumber;
        delete emp.aadhaarNumber;
        delete emp.bankName;
        delete emp.bankAccountNumber;
        delete emp.bankIfsc;
        delete emp.bankBranch;
        delete emp.salaryCtc;
      });
    }

    return res.status(200).json({ employees: formatted, pagination: { limit, offset } });
  } catch (error) {
    logger.error('Fetch employees error:', error);
    return res.status(500).json({ error: 'Failed to fetch employees list' });
  }
});

// GET /api/v1/employees/branches - Get all branches for dropdown
router.get('/branches', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const branches = await prisma.branch.findMany({
      where: { company_id: req.user!.companyId },
    });
    return res.status(200).json({ branches });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to fetch branches' });
  }
});

// GET /api/v1/employees/managers - Get list of reporting managers
router.get('/managers', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const managers = await prisma.employee.findMany({
      where: {
        company_id: req.user!.companyId,
        roles: {
          some: {
            role: {
              name: { in: [Roles.MD, Roles.HR_MANAGER, Roles.PROJECT_MANAGER, Roles.MARKETING_DIRECTOR, Roles.DIGITAL_MARKETING_HEAD] },
            },
          },
        },
      },
      select: {
        id: true,
        employee_code: true,
        full_name: true,
        job_title: true,
      },
    });

    const formatted = managers.map((m) => ({
      id: m.id,
      label: `${m.full_name || m.employee_code} (${m.job_title || 'Manager'}) - ${m.employee_code}`,
    }));

    return res.status(200).json({ managers: formatted });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to fetch managers' });
  }
});

// POST /api/v1/employees - Add new employee with all 20 industrial fields
router.post('/', authenticateToken, requireAuthz(Permissions.EMPLOYEES_CREATE), validateRequestBody(EmployeeCreateSchema), async (req: AuthenticatedRequest, res: Response) => {
  try {

    const {
      full_name,
      phone,
      secondary_phone,
      whatsapp_number,
      email,
      blood_group,
      social_links,
      current_address,
      permanent_address,
      emergency_contact_name,
      emergency_contact_relation,
      emergency_contact_phone,
      pan_number,
      aadhaar_number,
      bank_name,
      bank_account_number,
      bank_ifsc,
      bank_branch,
      job_title,
      department,
      employment_type,
      reporting_manager_id,
      date_of_joining,
      salary_ctc,
      background_education,
      role_name,
      branch_id,
      additional_branch_ids,
      initial_password,
    } = req.body;

    if (!role_name || !branch_id || !full_name || !phone) {
      return res.status(400).json({ error: 'Full Name, Primary Phone, Role, and Branch are required fields' });
    }

    const userRoles = req.user!.roles;
    const isUserAdmin = userRoles.includes(Roles.ADMIN);
    const isUserMD = userRoles.includes(Roles.MD);

    if (role_name === Roles.ADMIN && !isUserAdmin) {
      return res.status(403).json({ error: 'Forbidden: Only ADMIN can create ADMIN accounts' });
    }
    if (role_name === Roles.MD && !isUserAdmin && !isUserMD) {
      return res.status(403).json({ error: 'Forbidden: Only ADMIN or MD can create MD accounts' });
    }

    const parsedBranchId = parseInt(branch_id, 10);
    const branch = await prisma.branch.findUnique({ where: { id: parsedBranchId } });
    if (!branch) {
      return res.status(404).json({ error: 'Branch not found' });
    }
    if (!isUserAdmin && branch.company_id !== req.user!.companyId) {
      return res.status(403).json({ error: 'Forbidden: Cannot create employee in another company\'s branch' });
    }

    const validAdditionalBranchIds: number[] = [];
    if (Array.isArray(additional_branch_ids)) {
      const additionalBranches = await prisma.branch.findMany({
        where: {
          id: { in: additional_branch_ids.map((id: string) => parseInt(id, 10)) },
          company_id: isUserAdmin && req.body.company_id ? parseInt(req.body.company_id, 10) : req.user!.companyId
        }
      });
      for (const b of additionalBranches) {
        if (b.id !== parsedBranchId) validAdditionalBranchIds.push(b.id);
      }
    }
    
    // Resolve target company ID (Admin can specify, otherwise forced to actor's company)
    const targetCompanyId = (isUserAdmin && req.body.company_id) ? parseInt(req.body.company_id, 10) : req.user!.companyId;

    const deptCode = DepartmentCodes[role_name] || 'EX';

    let employeeCode = '';
    let isUnique = false;
    while (!isUnique) {
      const randomNum = Math.floor(1000 + Math.random() * 9000); // 4-digit random number
      employeeCode = `RRH-${deptCode}-${randomNum}`;
      const existing = await prisma.employee.findFirst({ where: { employee_code: employeeCode } });
      if (!existing) {
        isUnique = true;
      }
    }

    const role = await prisma.role.findUnique({
      where: { name: role_name },
    });

    if (!role) {
      return res.status(400).json({ error: 'Invalid role specified' });
    }

    const passwordHash = await bcrypt.hash(initial_password || 'Radhareal@123', 12);
    const isExempt = [Roles.MD, Roles.HR_MANAGER, Roles.ADMIN, Roles.MARKETING_DIRECTOR].includes(role_name);

    const newEmp = await prisma.employee.create({
      data: {
        employee_code: employeeCode,
        full_name,
        phone,
        secondary_phone,
        whatsapp_number: whatsapp_number || phone,
        email,
        blood_group: blood_group || 'O+',
        social_links,
        current_address,
        permanent_address: permanent_address || current_address,
        emergency_contact_name,
        emergency_contact_relation,
        emergency_contact_phone,
        pan_number: encryptData(pan_number),
        aadhaar_number: encryptData(aadhaar_number),
        bank_name: encryptData(bank_name),
        bank_account_number: encryptData(bank_account_number),
        bank_ifsc: encryptData(bank_ifsc),
        bank_branch: encryptData(bank_branch),
        job_title: job_title || role_name,
        department: department || 'Operations',
        employment_type: employment_type || 'FULL_TIME',
        report_required: employment_type === 'FULL_TIME',
        reporting_manager_id: reporting_manager_id ? parseInt(reporting_manager_id, 10) : null,
        date_of_joining: date_of_joining ? new Date(date_of_joining) : new Date(),
        salary_ctc: salary_ctc ? parseFloat(salary_ctc) : 35000,
        background_education,
        company_id: targetCompanyId,
        branch_id: parsedBranchId,
        password_hash: passwordHash,
        status: 'ACTIVE',
        attendance_required: !isExempt,
        first_login_done: false,
        roles: {
          create: {
            role_id: role.id,
          },
        },
        branches: {
          create: validAdditionalBranchIds.map(id => ({ branch_id: id }))
        }
      },
      include: {
        branch: true,
        roles: { include: { role: true } },
        branches: { include: { branch: true } },
      },
    });

    return res.status(201).json({
      message: 'Employee created successfully',
      employee: {
        id: newEmp.id,
        employeeCode: newEmp.employee_code,
        fullName: newEmp.full_name,
        branch: newEmp.branch?.name || 'All Branches',
        additionalBranches: newEmp.branches.map(b => b.branch.name),
        status: newEmp.status,
        attendanceRequired: newEmp.attendance_required,
        roles: newEmp.roles.map((r) => r.role.name),
        defaultPassword: initial_password || 'Radhareal@123',
      },
    });
  } catch (error) {
    logger.error('Create employee error:', error);
    return res.status(500).json({ error: 'Failed to create employee' });
  }
});

// PATCH /api/v1/employees/:id - Update employee status, branch, roles or any profile detail
router.patch('/:id', authenticateToken, requireAuthz(Permissions.EMPLOYEES_UPDATE), validateRequestBody(EmployeeUpdateSchema), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const employeeId = parseInt(req.params.id, 10);
    const targetEmployee = await prisma.employee.findUnique({ where: { id: employeeId } });
    if (!targetEmployee) {
      return res.status(404).json({ error: 'Employee not found' });
    }

    // Phase 4: Record-level and company-level authorization
    if (!can(req.user!, Permissions.EMPLOYEES_UPDATE, targetEmployee)) {
      return res.status(403).json({ error: 'Forbidden: Cannot update an employee outside your company' });
    }

    const canViewSensitive = can(req.user!, Permissions.EMPLOYEES_VIEW_SENSITIVE, targetEmployee);
    const body = req.body;

    // Privilege Escalation Check: Prevent self-promotion or assigning Admin/MD roles unless authorized
    if (body.role_name) {
      if (employeeId === req.user!.employeeId && body.role_name !== targetEmployee.job_title) {
        return res.status(403).json({ error: 'Forbidden: Cannot self-promote or change own role' });
      }
      
      if (body.role_name === Roles.ADMIN && !req.user!.roles.includes(Roles.ADMIN)) {
        return res.status(403).json({ error: 'Forbidden: Only Admin can assign Admin role' });
      }
      
      if (body.role_name === Roles.MD && !req.user!.roles.includes(Roles.ADMIN) && !req.user!.roles.includes(Roles.MD)) {
        return res.status(403).json({ error: 'Forbidden: Only MD or Admin can assign MD role' });
      }
    }

    const updateData: any = {};
    if (body.full_name !== undefined) updateData.full_name = body.full_name;
    if (body.phone !== undefined) updateData.phone = body.phone;
    if (body.secondary_phone !== undefined) updateData.secondary_phone = body.secondary_phone;
    if (body.whatsapp_number !== undefined) updateData.whatsapp_number = body.whatsapp_number;
    if (body.email !== undefined) updateData.email = body.email;
    if (body.blood_group !== undefined) updateData.blood_group = body.blood_group;
    if (body.social_links !== undefined) updateData.social_links = body.social_links;
    if (body.current_address !== undefined) updateData.current_address = body.current_address;
    if (body.permanent_address !== undefined) updateData.permanent_address = body.permanent_address;
    if (body.emergency_contact_name !== undefined) updateData.emergency_contact_name = body.emergency_contact_name;
    if (body.emergency_contact_relation !== undefined) updateData.emergency_contact_relation = body.emergency_contact_relation;
    if (body.emergency_contact_phone !== undefined) updateData.emergency_contact_phone = body.emergency_contact_phone;
    
    // Reject attempt to modify sensitive fields if unauthorized (BEFORE generic auth)
    if (!canViewSensitive) {
      if (
        body.pan_number !== undefined ||
        body.aadhaar_number !== undefined ||
        body.bank_name !== undefined ||
        body.bank_account_number !== undefined ||
        body.bank_ifsc !== undefined ||
        body.bank_branch !== undefined ||
        body.salary_ctc !== undefined
      ) {
        return res.status(403).json({ error: 'Cannot modify sensitive fields' });
      }
    } else {
      if (body.pan_number !== undefined) updateData.pan_number = body.pan_number;
      if (body.aadhaar_number !== undefined) updateData.aadhaar_number = body.aadhaar_number;
      if (body.bank_name !== undefined) updateData.bank_name = body.bank_name;
      if (body.bank_account_number !== undefined) updateData.bank_account_number = body.bank_account_number;
      if (body.bank_ifsc !== undefined) updateData.bank_ifsc = body.bank_ifsc;
      if (body.bank_branch !== undefined) updateData.bank_branch = body.bank_branch;
      if (body.salary_ctc !== undefined) updateData.salary_ctc = parseFloat(body.salary_ctc);
    }

    if (body.job_title !== undefined) updateData.job_title = body.job_title;
    if (body.department !== undefined) updateData.department = body.department;
    if (body.employment_type !== undefined) updateData.employment_type = body.employment_type;
    if (body.report_required !== undefined) updateData.report_required = Boolean(body.report_required);
    if (body.reporting_manager_id !== undefined) updateData.reporting_manager_id = body.reporting_manager_id ? parseInt(body.reporting_manager_id, 10) : null;
    if (body.date_of_joining !== undefined) updateData.date_of_joining = new Date(body.date_of_joining);
    if (body.background_education !== undefined) updateData.background_education = body.background_education;
    if (body.branch_id !== undefined) updateData.branch_id = parseInt(body.branch_id, 10);
    if (body.status !== undefined) updateData.status = body.status;
    if (body.attendance_required !== undefined) updateData.attendance_required = Boolean(body.attendance_required);

    let shouldRevokeSessions = false;
    if (body.status !== undefined && body.status !== targetEmployee.status) {
      shouldRevokeSessions = true;
    }

    const updatedEmp = await prisma.$transaction(async (tx) => {
      if (body.role_name) {
        const targetRole = await tx.role.findUnique({ where: { name: body.role_name } });
        if (targetRole) {
          const currentRoles = await tx.employeeRole.findMany({ where: { employee_id: employeeId }, include: { role: true } });
          const hasDifferentRole = !currentRoles.some((r: any) => r.role.name === body.role_name);
          if (hasDifferentRole) {
            shouldRevokeSessions = true;
          }

          await tx.employeeRole.deleteMany({ where: { employee_id: employeeId } });
          await tx.employeeRole.create({
            data: {
              employee_id: employeeId,
              role_id: targetRole.id,
            },
          });
        }
      }

      if (shouldRevokeSessions) {
        updateData.token_version = { increment: 1 };
      }

      const emp = await tx.employee.update({
        where: { id: employeeId },
        data: updateData,
        include: {
          branch: true,
          roles: { include: { role: true } },
        },
      });

      if (shouldRevokeSessions) {
        await tx.authSession.updateMany({
          where: { employee_id: employeeId, revoked: false },
          data: { revoked: true, revocation_reason: 'AUTHORIZATION_CHANGED' }
        });
      }

      return emp;
    });

    // ── Universal Notifications ──────────────────────────────────
    // Notify the employee for every significant profile change
    const notifyPromises: Promise<void>[] = [];

    if (body.salary_ctc !== undefined) {
      notifyPromises.push(notifyEmployee(employeeId, {
        type: 'SALARY_CHANGED',
        title: '💰 Your Salary Has Been Updated',
        message: `Your monthly CTC has been updated to ₹${parseFloat(body.salary_ctc).toLocaleString('en-IN')}. Please contact HR for any queries.`,
      }));
    }

    if (body.role_name) {
      notifyPromises.push(notifyEmployee(employeeId, {
        type: 'ROLE_CHANGED',
        title: '🏷️ Your Role Has Been Updated',
        message: `Your position has been updated to "${body.role_name}". Please check with your manager for next steps.`,
      }));
    }

    if (body.status !== undefined) {
      const statusMessages: Record<string, string> = {
        ACTIVE:    '✅ Your account has been activated.',
        INACTIVE:  '⚠️ Your account has been deactivated. Contact HR for details.',
        SUSPENDED: '🚫 Your account has been suspended. Contact HR immediately.',
      };
      const msg = statusMessages[body.status] || `Your account status was changed to ${body.status}.`;
      notifyPromises.push(notifyEmployee(employeeId, {
        type: 'STATUS_CHANGED',
        title: '🔔 Account Status Changed',
        message: msg,
      }));
    }

    if (body.branch_id !== undefined) {
      notifyPromises.push(notifyEmployee(employeeId, {
        type: 'BRANCH_CHANGED',
        title: '🏢 Your Branch/Department Has Changed',
        message: `You have been transferred to a new branch/department. Please check with HR for your reporting details.`,
      }));
    }

    if (body.job_title !== undefined) {
      notifyPromises.push(notifyEmployee(employeeId, {
        type: 'JOB_TITLE_CHANGED',
        title: '💼 Your Job Title Has Been Updated',
        message: `Your job title has been updated to "${body.job_title}".`,
      }));
    }

    await Promise.allSettled(notifyPromises);
    // ─────────────────────────────────────────────────────────────

    return res.status(200).json({
      message: 'Employee details updated successfully',
      employee: updatedEmp,
    });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to update employee' });
  }
});

// POST /api/v1/employees/:id/reset-password - Admin 1-click Password Reset
router.post('/:id/reset-password', authenticateToken, requireAuthz(Permissions.EMPLOYEES_RESET_PASSWORD), validateRequestBody(EmptyBodySchema), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const employeeId = parseInt(req.params.id, 10);
    const targetEmployee = await prisma.employee.findUnique({ where: { id: employeeId } });
    if (!targetEmployee) {
      return res.status(404).json({ error: 'Employee not found' });
    }

    if (!can(req.user!, Permissions.EMPLOYEES_RESET_PASSWORD, targetEmployee)) {
      return res.status(403).json({ error: 'Forbidden: Cannot reset password for employee outside your company' });
    }

    const newHash = await bcrypt.hash('Radhareal@123', 12);

    await prisma.$transaction(async (tx) => {
      await tx.employee.update({
        where: { id: employeeId },
        data: {
          password_hash: newHash,
          first_login_done: false,
          token_version: { increment: 1 }
        },
      });

      await tx.authSession.updateMany({
        where: { employee_id: employeeId, revoked: false },
        data: { revoked: true, revocation_reason: 'ADMIN_PASSWORD_RESET' }
      });
    });

    // Notify employee their password was reset by admin
    await notifyEmployee(employeeId, {
      type: 'PASSWORD_RESET',
      title: '🔐 Your Password Has Been Reset',
      message: 'An administrator has reset your password to the default. Please log in and change it immediately.',
    });

    return res.status(200).json({
      message: 'Password reset to default (Password@123) successfully',
    });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to reset employee password' });
  }
});

// PUT /api/v1/employees/:id/roles - Update an employee's roles
router.put('/:id/roles', authenticateToken, validateRequestBody(EmployeeRolesUpdateSchema), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const employeeId = parseInt(req.params.id, 10);
    const { role_names } = req.body;

    if (!Array.isArray(role_names)) {
      return res.status(400).json({ error: 'role_names must be an array of strings' });
    }

    const userRoles = req.user!.roles;
    const isUserAdmin = userRoles.includes(Roles.ADMIN);
    const isUserMD = userRoles.includes(Roles.MD);

    if (!isUserAdmin && !isUserMD) {
      return res.status(403).json({ error: 'Forbidden: Only MD or ADMIN can assign roles' });
    }

    const targetEmployee = await prisma.employee.findUnique({
      where: { id: employeeId },
      include: { branch: true }
    });

    if (!targetEmployee) {
      return res.status(404).json({ error: 'Employee not found' });
    }

    // Tenant check: target employee must be in same company_id
    if (targetEmployee.branch?.company_id !== req.user!.companyId && !isUserAdmin) {
      return res.status(403).json({ error: 'Forbidden: Cannot manage roles for an employee outside your company' });
    }
    
    // Check if roles are valid according to shared constants
    const validRolesSet = new Set(Object.values(Roles));
    for (const role of role_names) {
      if (!validRolesSet.has(role)) {
        return res.status(400).json({ error: `Invalid role: ${role}` });
      }
    }

    // Privilege escalation check
    if (role_names.includes(Roles.ADMIN) && !isUserAdmin) {
      return res.status(403).json({ error: 'Forbidden: Only ADMIN can assign ADMIN role' });
    }

    // Check if removing the last MD in the company
    const currentRoles = await prisma.employeeRole.findMany({
      where: { employee_id: employeeId },
      include: { role: true }
    });
    
    const wasMD = currentRoles.some((r: any) => r.role.name === Roles.MD);
    const willBeMD = role_names.includes(Roles.MD);

    if (wasMD && !willBeMD) {
      const companyId = targetEmployee.branch?.company_id;
      if (companyId) {
        const otherMDs = await prisma.employeeRole.count({
          where: {
            role: { name: Roles.MD },
            employee_id: { not: employeeId },
            employee: { branch: { company_id: companyId } }
          }
        });
        if (otherMDs === 0) {
          return res.status(400).json({ error: 'Cannot remove the last Managing Director from the company' });
        }
      }
    }

    // Fetch role DB IDs
    const targetRoles = await prisma.role.findMany({
      where: { name: { in: role_names } }
    });

    if (targetRoles.length !== role_names.length) {
      return res.status(400).json({ error: 'One or more roles do not exist in the database' });
    }

    await prisma.$transaction(async (tx) => {
      // Clear existing roles
      await tx.employeeRole.deleteMany({ where: { employee_id: employeeId } });

      // Add new roles
      await tx.employeeRole.createMany({
        data: targetRoles.map((r: any) => ({
          employee_id: employeeId,
          role_id: r.id
        }))
      });

      // Invalidate sessions
      await tx.employee.update({
        where: { id: employeeId },
        data: { token_version: { increment: 1 } }
      });

      await tx.authSession.updateMany({
        where: { employee_id: employeeId, revoked: false },
        data: { revoked: true, revocation_reason: 'AUTHORIZATION_CHANGED' }
      });
    });

    await notifyEmployee(employeeId, {
      type: 'ROLE_CHANGED',
      title: '🏷️ Your Roles Have Been Updated',
      message: 'Your system roles have been updated by an administrator. Please log in again to apply changes.',
    });

    return res.status(200).json({ message: 'Roles updated successfully' });
  } catch (error) {
    logger.error('Update roles error:', error);
    return res.status(500).json({ error: 'Failed to update roles' });
  }
});

export default router;
