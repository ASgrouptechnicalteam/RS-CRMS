"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const authz_1 = require("../middleware/authz");
const validate_1 = require("../middleware/validate");
const shared_1 = require("../shared");
const shared_2 = require("../shared");
const expenseRefund_service_1 = require("../services/expenseRefund.service");
const multer_1 = __importDefault(require("multer"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const router = (0, express_1.Router)();
const storage_service_1 = require("../services/storage.service");
const upload = (0, multer_1.default)({
    storage: multer_1.default.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        const allowed = ['.jpg', '.jpeg', '.png', '.pdf', '.webp'];
        const ext = path_1.default.extname(file.originalname).toLowerCase();
        if (allowed.includes(ext))
            cb(null, true);
        else
            cb(new Error('Only images (JPG, PNG, WebP) and PDFs are allowed.'));
    },
});
router.get('/my', auth_1.authenticateToken, (0, auth_1.requirePermission)([shared_2.Permissions.EXPENSES_READ_OWN]), async (req, res, next) => {
    try {
        const refunds = await expenseRefund_service_1.ExpenseRefundService.listMyRefunds(req.user);
        return res.status(200).json({ refunds });
    }
    catch (error) {
        next(error);
    }
});
router.get('/queue', auth_1.authenticateToken, (0, auth_1.requirePermission)([shared_2.Permissions.EXPENSES_REVIEW, shared_2.Permissions.EXPENSES_MD_APPROVE]), async (req, res, next) => {
    try {
        const refunds = await expenseRefund_service_1.ExpenseRefundService.listQueue(req.user);
        return res.status(200).json({ refunds });
    }
    catch (error) {
        next(error);
    }
});
router.post('/', auth_1.authenticateToken, (0, auth_1.requirePermission)([shared_2.Permissions.EXPENSES_CREATE]), upload.single('proof_image'), (0, validate_1.validateRequestBody)(shared_1.ExpenseRefundCreateSchema), async (req, res, next) => {
    try {
        const { purpose, amount } = req.body;
        let proofImageUrl = null;
        if (req.file) {
            const storageService = (0, storage_service_1.getStorageService)('expense-proofs');
            proofImageUrl = await storageService.upload(req.file.buffer, req.file.originalname, req.file.mimetype);
        }
        const refund = await expenseRefund_service_1.ExpenseRefundService.createRefund(req.user, { purpose, amount }, proofImageUrl);
        return res.status(201).json({ message: 'Refund request submitted.', refund });
    }
    catch (error) {
        next(error);
    }
});
router.patch('/:id/accountant-review', auth_1.authenticateToken, (0, authz_1.requireAuthz)(shared_2.Permissions.EXPENSES_REVIEW), (0, validate_1.validateRequestBody)(shared_1.ExpenseRefundAccountantReviewSchema), async (req, res, next) => {
    try {
        const id = parseInt(req.params.id, 10);
        const { decision, note } = req.body;
        const updated = await expenseRefund_service_1.ExpenseRefundService.accountantReview(req.user, id, decision, note);
        return res.status(200).json({ message: 'Review recorded.', refund: updated });
    }
    catch (error) {
        next(error);
    }
});
router.patch('/:id/md-review', auth_1.authenticateToken, (0, authz_1.requireAuthz)(shared_2.Permissions.EXPENSES_MD_APPROVE), (0, validate_1.validateRequestBody)(shared_1.ExpenseRefundMDReviewSchema), async (req, res, next) => {
    try {
        const id = parseInt(req.params.id, 10);
        const { decision, note } = req.body;
        const updated = await expenseRefund_service_1.ExpenseRefundService.mdReview(req.user, id, decision, note);
        return res.status(200).json({ message: 'MD review recorded.', refund: updated });
    }
    catch (error) {
        next(error);
    }
});
router.patch('/:id/mark-refunded', auth_1.authenticateToken, (0, authz_1.requireAuthz)(shared_2.Permissions.EXPENSES_MARK_REFUNDED), (0, validate_1.validateRequestBody)(shared_1.ExpenseRefundMarkRefundedSchema), async (req, res, next) => {
    try {
        const id = parseInt(req.params.id, 10);
        const updated = await expenseRefund_service_1.ExpenseRefundService.markRefunded(req.user, id);
        return res.status(200).json({ message: 'Marked as refunded.', refund: updated });
    }
    catch (error) {
        next(error);
    }
});
router.get('/:id/proof', auth_1.authenticateToken, (0, authz_1.requireAuthz)(shared_2.Permissions.EXPENSES_READ_OWN), async (req, res, next) => {
    try {
        const id = parseInt(req.params.id, 10);
        const proofUrl = await expenseRefund_service_1.ExpenseRefundService.getProof(req.user, id);
        const filePath = path_1.default.join(process.cwd(), proofUrl);
        if (!fs_1.default.existsSync(filePath)) {
            return res.status(404).json({ error: 'Proof image file not found on server.' });
        }
        return res.sendFile(filePath);
    }
    catch (error) {
        next(error);
    }
});
exports.default = router;
