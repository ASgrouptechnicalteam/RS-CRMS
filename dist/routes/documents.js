"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const validate_1 = require("../middleware/validate");
const shared_1 = require("@rrh-ems/shared");
const document_service_1 = require("../services/document.service");
const document_generation_service_1 = require("../services/document-generation.service");
const multer_1 = __importDefault(require("multer"));
const router = (0, express_1.Router)();
const upload = (0, multer_1.default)({
    storage: multer_1.default.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        const allowed = ['.jpg', '.jpeg', '.png', '.pdf', '.webp'];
        const ext = require('path').extname(file.originalname).toLowerCase();
        if (allowed.includes(ext))
            cb(null, true);
        else
            cb(new Error('Only PDF, JPG, JPEG, PNG, and WEBP files are allowed.'));
    },
});
router.get('/', auth_1.authenticateToken, (0, auth_1.requirePermission)([shared_1.Permissions.DOCUMENTS_READ]), async (req, res, next) => {
    try {
        const filters = {
            customer_id: req.query.customer_id ? parseInt(req.query.customer_id, 10) : undefined,
            lead_id: req.query.lead_id ? parseInt(req.query.lead_id, 10) : undefined,
            opportunity_id: req.query.opportunity_id ? parseInt(req.query.opportunity_id, 10) : undefined,
            booking_id: req.query.booking_id ? parseInt(req.query.booking_id, 10) : undefined,
            property_id: req.query.property_id ? parseInt(req.query.property_id, 10) : undefined,
            project_id: req.query.project_id ? parseInt(req.query.project_id, 10) : undefined,
            payment_id: req.query.payment_id ? parseInt(req.query.payment_id, 10) : undefined,
            document_type: req.query.document_type,
            status: req.query.status,
            verification_status: req.query.verification_status,
            page: req.query.page ? parseInt(req.query.page, 10) : 1,
            limit: req.query.limit ? parseInt(req.query.limit, 10) : 20,
        };
        const result = await document_service_1.DocumentService.listDocuments(req.user, filters);
        return res.status(200).json(result);
    }
    catch (error) {
        next(error);
    }
});
router.get('/:id', auth_1.authenticateToken, (0, auth_1.requirePermission)([shared_1.Permissions.DOCUMENTS_READ]), async (req, res, next) => {
    try {
        const id = parseInt(req.params.id, 10);
        const doc = await document_service_1.DocumentService.getDocument(req.user, id);
        return res.status(200).json({ document: doc });
    }
    catch (error) {
        next(error);
    }
});
router.post('/', auth_1.authenticateToken, (0, auth_1.requirePermission)([shared_1.Permissions.DOCUMENTS_CREATE]), (req, res, next) => {
    upload.single('file')(req, res, (err) => {
        if (err) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({ error: 'File size exceeds maximum of 10MB' });
            }
            return res.status(400).json({ error: 'File upload failed' });
        }
        next();
    });
}, (0, validate_1.validateRequestBody)(shared_1.DocumentUploadSchema), async (req, res, next) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file provided' });
        }
        const doc = await document_service_1.DocumentService.uploadDocument(req.user, req.file, req.body);
        return res.status(201).json({ message: 'Document uploaded successfully.', document: doc });
    }
    catch (error) {
        next(error);
    }
});
router.post('/generate-agreement', auth_1.authenticateToken, (0, auth_1.requirePermission)([shared_1.Permissions.DOCUMENTS_CREATE]), async (req, res, next) => {
    try {
        const { booking_id } = req.body;
        if (!booking_id) {
            return res.status(400).json({ error: 'booking_id is required' });
        }
        const doc = await document_generation_service_1.DocumentGenerationService.generateAgreement(req.user, parseInt(booking_id, 10));
        return res.status(201).json({ message: 'Agreement generated successfully.', document: doc });
    }
    catch (error) {
        next(error);
    }
});
router.get('/:id/download', auth_1.authenticateToken, (0, auth_1.requirePermission)([shared_1.Permissions.DOCUMENTS_READ]), async (req, res, next) => {
    try {
        const id = parseInt(req.params.id, 10);
        const { fileBuffer, document: doc } = await document_service_1.DocumentService.downloadDocument(req.user, id);
        res.setHeader('Content-Type', doc.mime_type);
        res.setHeader('Content-Disposition', 'attachment; filename="' + doc.original_name.replace(/[^a-zA-Z0-9._-]/g, '_') + '"');
        return res.send(Buffer.from(fileBuffer));
    }
    catch (error) {
        next(error);
    }
});
router.patch('/:id/verify', auth_1.authenticateToken, (0, auth_1.requirePermission)([shared_1.Permissions.DOCUMENTS_VERIFY]), (0, validate_1.validateRequestBody)(shared_1.DocumentVerifySchema), async (req, res, next) => {
    try {
        const id = parseInt(req.params.id, 10);
        const { status, notes } = req.body;
        const doc = await document_service_1.DocumentService.verifyDocument(req.user, id, status, notes);
        return res.status(200).json({ message: 'Document ' + status.toLowerCase() + '.', document: doc });
    }
    catch (error) {
        next(error);
    }
});
router.patch('/:id/archive', auth_1.authenticateToken, (0, auth_1.requirePermission)([shared_1.Permissions.DOCUMENTS_DELETE]), (0, validate_1.validateRequestBody)(shared_1.DocumentArchiveSchema), async (req, res, next) => {
    try {
        const id = parseInt(req.params.id, 10);
        const { reason } = req.body;
        const doc = await document_service_1.DocumentService.archiveDocument(req.user, id, reason);
        return res.status(200).json({ message: 'Document archived.', document: doc });
    }
    catch (error) {
        next(error);
    }
});
router.patch('/:id/restore', auth_1.authenticateToken, (0, auth_1.requirePermission)([shared_1.Permissions.DOCUMENTS_DELETE]), async (req, res, next) => {
    try {
        const id = parseInt(req.params.id, 10);
        const doc = await document_service_1.DocumentService.restoreDocument(req.user, id);
        return res.status(200).json({ message: 'Document restored.', document: doc });
    }
    catch (error) {
        next(error);
    }
});
exports.default = router;
