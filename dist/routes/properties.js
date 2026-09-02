"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const logger_1 = require("../utils/logger");
const prisma_1 = require("../lib/prisma");
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const authz_1 = require("../middleware/authz");
const shared_1 = require("../shared");
const validate_1 = require("../middleware/validate");
const property_service_1 = require("../services/property.service");
const storage_service_1 = require("../services/storage.service");
const router = (0, express_1.Router)();
const p = prisma_1.prisma;
// GET /api/v1/properties - List properties with brand and status filtering
router.get('/', auth_1.authenticateToken, (0, authz_1.requireAuthz)(shared_1.Permissions.PROPERTIES_READ), async (req, res, next) => {
    try {
        const { brand, status, project_id, unassigned, dm_executive_id } = req.query;
        const filters = {
            brand: typeof brand === 'string' ? brand : undefined,
            status: typeof status === 'string' ? status : undefined,
            project_id: typeof project_id === 'string' ? parseInt(project_id, 10) : undefined,
            unassigned: unassigned === 'true',
            dm_executive_id: typeof dm_executive_id === 'string' ? parseInt(dm_executive_id, 10) : undefined,
        };
        // DM Executives automatically see only their own assigned-to-polish properties
        const userRoles = req.user?.roles || [];
        const isDMExecutiveOnly = userRoles.includes('digital marketing executive') &&
            !userRoles.some((r) => ['Digital Marketing head(manager)', 'Marketing Director', 'md', 'admin'].includes(r));
        if (isDMExecutiveOnly && !filters.dm_executive_id) {
            filters.dm_executive_id = req.user.employeeId;
        }
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
        const offset = Math.max(parseInt(req.query.offset) || 0, 0);
        const properties = await property_service_1.PropertyService.listProperties(req.user, filters, limit, offset);
        return res.status(200).json({ properties, pagination: { limit, offset } });
    }
    catch (error) {
        logger_1.logger.error('Fetch properties error:', error);
        if (error.status) {
            return next(error);
        }
        return res.status(500).json({ error: 'Failed to fetch properties' });
    }
});
// POST /api/v1/properties - Create Property Listing
router.post('/', auth_1.authenticateToken, (0, authz_1.requireAuthz)(shared_1.Permissions.PROPERTIES_CREATE), (0, validate_1.validateRequestBody)(shared_1.PropertyCreateSchema), async (req, res, next) => {
    try {
        const property = await property_service_1.PropertyService.createProperty(req.user, req.body);
        return res.status(201).json({
            message: 'Property listing created and submitted for PM On-Site Verification',
            property,
        });
    }
    catch (error) {
        logger_1.logger.error('Create property error:', error);
        if (error.status) {
            return next(error);
        }
        return res.status(500).json({ error: 'Failed to create property listing' });
    }
});
// PUT /api/v1/properties/:id - Update Property Listing
router.put('/:id', auth_1.authenticateToken, (0, authz_1.requireAuthz)(shared_1.Permissions.PROPERTIES_UPDATE), (0, validate_1.validateRequestBody)(shared_1.PropertyUpdateSchema), async (req, res, next) => {
    try {
        const propertyId = parseInt(req.params.id, 10);
        if (isNaN(propertyId))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        if (isNaN(propertyId))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        if (isNaN(propertyId))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        if (isNaN(propertyId))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        const property = await property_service_1.PropertyService.updateProperty(req.user, propertyId, req.body);
        return res.status(200).json({
            message: 'Property listing updated successfully',
            property,
        });
    }
    catch (error) {
        logger_1.logger.error('Update property error:', error);
        if (error.status) {
            return next(error);
        }
        return res.status(500).json({ error: 'Failed to update property listing' });
    }
});
// POST /api/v1/properties/:id/confirm-location - PM confirms on-site location details are accurate
// This is a prerequisite for the verify action — setting this flag is a distinct, explicit PM decision.
router.post('/:id/confirm-location', auth_1.authenticateToken, (0, authz_1.requireAuthz)(shared_1.Permissions.PROPERTIES_VERIFY), (0, validate_1.validateRequestBody)(shared_1.EmptyBodySchema), async (req, res, next) => {
    try {
        const propertyId = parseInt(req.params.id, 10);
        if (isNaN(propertyId))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        const result = await property_service_1.PropertyService.confirmLocationByPM(req.user, propertyId);
        return res.status(200).json({
            message: `Location confirmed for property ${result.property_code}`,
            property: result,
        });
    }
    catch (error) {
        logger_1.logger.error('Confirm location error:', error);
        if (error.status)
            return next(error);
        return res.status(500).json({ error: 'Failed to confirm location' });
    }
});
// POST /api/v1/properties/:id/verify - PM On-Site Verification Step
router.post('/:id/verify', auth_1.authenticateToken, (0, authz_1.requireAuthz)(shared_1.Permissions.PROPERTIES_VERIFY), (0, validate_1.validateRequestBody)(shared_1.PropertyVerificationSchema), async (req, res, next) => {
    try {
        const propertyId = parseInt(req.params.id, 10);
        if (isNaN(propertyId))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        if (isNaN(propertyId))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        if (isNaN(propertyId))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        if (isNaN(propertyId))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        const updated = await property_service_1.PropertyService.verifyProperty(req.user, propertyId, req.body);
        return res.status(200).json({
            message: `Property ${updated.property_code} verification updated to ${updated.status}`,
            property: updated,
        });
    }
    catch (error) {
        logger_1.logger.error('PM Verify error:', error);
        if (error.status) {
            return next(error);
        }
        return res.status(500).json({ error: 'Failed to execute PM verification step' });
    }
});
// POST /api/v1/properties/:id/dm-polish - Digital Marketing Polish & SEO Tagging Step
router.post('/:id/dm-polish', auth_1.authenticateToken, (0, authz_1.requireAuthz)(shared_1.Permissions.PROPERTIES_DM_POLISH), (0, validate_1.validateRequestBody)(shared_1.PropertyDMUpdateSchema), async (req, res, next) => {
    try {
        const propertyId = parseInt(req.params.id, 10);
        if (isNaN(propertyId))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        if (isNaN(propertyId))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        if (isNaN(propertyId))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        if (isNaN(propertyId))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        const updated = await property_service_1.PropertyService.dmPolishProperty(req.user, propertyId, req.body);
        return res.status(200).json({
            message: `Property ${updated.property_code} polished by DM team and submitted for MD Approval`,
            property: updated,
        });
    }
    catch (error) {
        logger_1.logger.error('DM Polish error:', error);
        if (error.status) {
            return next(error);
        }
        return res.status(500).json({ error: 'Failed to execute DM polish step' });
    }
});
// POST /api/v1/properties/:id/dm-verify-as-is - Digital Marketing Head "Verified As-Is" bypass
// Skips polish assignment and advances directly to PENDING_MD_APPROVAL.
// Uses same PROPERTIES_DM_POLISH permission gate as the standard polish path.
router.post('/:id/dm-verify-as-is', auth_1.authenticateToken, (0, authz_1.requireAuthz)(shared_1.Permissions.PROPERTIES_DM_POLISH), (0, validate_1.validateRequestBody)(shared_1.PropertyDMVerifyAsIsSchema), async (req, res, next) => {
    try {
        const propertyId = parseInt(req.params.id, 10);
        if (isNaN(propertyId))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        const updated = await property_service_1.PropertyService.dmVerifyAsIsProperty(req.user, propertyId, req.body);
        return res.status(200).json({
            message: `Property ${updated.property_code} verified as-is by DM Head and submitted for MD Approval`,
            property: updated,
        });
    }
    catch (error) {
        logger_1.logger.error('DM Verify As-Is error:', error);
        if (error.status) {
            return next(error);
        }
        return res.status(500).json({ error: 'Failed to execute DM verify-as-is step' });
    }
});
// POST /api/v1/properties/:id/md-approve - MD Final Approval Step (Go Live)
router.post('/:id/md-approve', auth_1.authenticateToken, (0, authz_1.requireAuthz)(shared_1.Permissions.PROPERTIES_MD_APPROVE), (0, validate_1.validateRequestBody)(shared_1.PropertyMDApprovalSchema), async (req, res, next) => {
    try {
        const propertyId = parseInt(req.params.id, 10);
        if (isNaN(propertyId))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        if (isNaN(propertyId))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        if (isNaN(propertyId))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        if (isNaN(propertyId))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        const updated = await property_service_1.PropertyService.mdApproveProperty(req.user, propertyId, req.body);
        return res.status(200).json({
            message: `Property ${updated.property_code} is now ${updated.status}`,
            property: updated,
        });
    }
    catch (error) {
        logger_1.logger.error('MD Approve error:', error);
        if (error.status) {
            return next(error);
        }
        return res.status(500).json({ error: 'Failed to execute MD approval step' });
    }
});
// POST /api/v1/properties/:id/publications - Toggle publication for a brand
router.post('/:id/publications', auth_1.authenticateToken, (0, authz_1.requireAuthz)(shared_1.Permissions.PROPERTIES_UPDATE), (0, validate_1.validateRequestBody)(shared_1.PropertyTogglePublicationBodySchema), async (req, res, next) => {
    try {
        const propertyId = parseInt(req.params.id, 10);
        if (isNaN(propertyId))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        if (isNaN(propertyId))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        if (isNaN(propertyId))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        if (isNaN(propertyId))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        const { company_id, is_published } = req.body;
        if (!company_id || typeof is_published !== 'boolean') {
            return res.status(400).json({ error: 'company_id and is_published (boolean) are required' });
        }
        const publication = await property_service_1.PropertyService.togglePublication(req.user, propertyId, company_id, is_published);
        return res.status(200).json({
            message: `Property ${is_published ? 'published' : 'unpublished'} successfully`,
            publication,
        });
    }
    catch (error) {
        logger_1.logger.error('Toggle publication error:', error);
        if (error.status) {
            return next(error);
        }
        return res.status(500).json({ error: 'Failed to toggle publication' });
    }
});
// GET /api/v1/properties/:id/publications - List publications for a property
router.get('/:id/publications', auth_1.authenticateToken, (0, authz_1.requireAuthz)(shared_1.Permissions.PROPERTIES_READ), async (req, res, next) => {
    try {
        const propertyId = parseInt(req.params.id, 10);
        if (isNaN(propertyId))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        if (isNaN(propertyId))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        if (isNaN(propertyId))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        if (isNaN(propertyId))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        const publications = await property_service_1.PropertyService.getPublications(req.user, propertyId);
        return res.status(200).json({ publications });
    }
    catch (error) {
        logger_1.logger.error('Get publications error:', error);
        if (error.status) {
            return next(error);
        }
        return res.status(500).json({ error: 'Failed to fetch publications' });
    }
});
// POST /api/v1/properties/:id/images - Upload property image
router.post('/:id/images', auth_1.authenticateToken, (0, authz_1.requireAuthz)(shared_1.Permissions.PROPERTIES_UPDATE), storage_service_1.propertyImageUpload.single('image'), (0, validate_1.validateRequestBody)(shared_1.PropertyImageMetadataSchema), async (req, res, next) => {
    try {
        const propertyId = parseInt(req.params.id, 10);
        if (isNaN(propertyId))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        if (isNaN(propertyId))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        if (isNaN(propertyId))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        if (isNaN(propertyId))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        const companyId = req.user.companyId;
        // Verify property exists and belongs to company
        const property = await p.property.findFirst({
            where: { id: propertyId, company_id: companyId },
        });
        if (!property) {
            return res.status(404).json({ error: 'Property not found or unauthorized' });
        }
        if (!req.file) {
            return res.status(400).json({ error: 'No image file provided' });
        }
        const storage = (0, storage_service_1.getPropertyImageStorage)();
        const imageUrl = await storage.upload(req.file.buffer, propertyId);
        const { alt_text, sort_order, is_primary } = req.body;
        const isPrimaryBool = is_primary === 'true' || is_primary === true;
        let image;
        await p.$transaction(async (tx) => {
            if (isPrimaryBool) {
                await tx.propertyImage.updateMany({
                    where: { property_id: propertyId, is_primary: true },
                    data: { is_primary: false },
                });
            }
            image = await tx.propertyImage.create({
                data: {
                    property_id: propertyId,
                    image_url: imageUrl,
                    is_primary: isPrimaryBool,
                    uploaded_by_id: req.user.employeeId,
                    sort_order: sort_order ? parseInt(sort_order, 10) : 0,
                    alt_text: alt_text || null,
                    status: 'PENDING',
                },
            });
        });
        return res.status(201).json({ message: 'Image uploaded successfully', image });
    }
    catch (error) {
        logger_1.logger.error('Upload property image error:', error);
        if (error.status) {
            return next(error);
        }
        return res.status(500).json({ error: 'Failed to upload image' });
    }
});
// PUT /api/v1/properties/:id/images/:imageId - Update image metadata
router.put('/:id/images/:imageId', auth_1.authenticateToken, (0, authz_1.requireAuthz)(shared_1.Permissions.PROPERTIES_UPDATE), (0, validate_1.validateRequestBody)(shared_1.PropertyImageMetadataSchema), async (req, res, next) => {
    try {
        const propertyId = parseInt(req.params.id, 10);
        if (isNaN(propertyId))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        if (isNaN(propertyId))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        if (isNaN(propertyId))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        if (isNaN(propertyId))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        const imageId = parseInt(req.params.imageId, 10);
        if (isNaN(imageId))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        if (isNaN(imageId))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        if (isNaN(imageId))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        if (isNaN(imageId))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        const companyId = req.user.companyId;
        // Verify property belongs to company
        const property = await p.property.findFirst({
            where: { id: propertyId, company_id: companyId },
        });
        if (!property) {
            return res.status(404).json({ error: 'Property not found or unauthorized' });
        }
        // Verify image belongs to property
        const image = await p.propertyImage.findFirst({
            where: { id: imageId, property_id: propertyId },
        });
        if (!image) {
            return res.status(404).json({ error: 'Image not found' });
        }
        const { alt_text, sort_order, is_primary } = req.body;
        const updateData = {};
        if (alt_text !== undefined)
            updateData.alt_text = alt_text || null;
        if (sort_order !== undefined)
            updateData.sort_order = parseInt(sort_order, 10);
        const isPrimaryBool = is_primary === 'true' || is_primary === true;
        if (is_primary !== undefined)
            updateData.is_primary = isPrimaryBool;
        let updated;
        await p.$transaction(async (tx) => {
            if (is_primary !== undefined && isPrimaryBool) {
                await tx.propertyImage.updateMany({
                    where: { property_id: propertyId, is_primary: true },
                    data: { is_primary: false },
                });
            }
            updated = await tx.propertyImage.update({
                where: { id: imageId },
                data: updateData,
            });
        });
        return res.status(200).json({ message: 'Image updated successfully', image: updated });
    }
    catch (error) {
        logger_1.logger.error('Update property image error:', error);
        if (error.status) {
            return next(error);
        }
        return res.status(500).json({ error: 'Failed to update image' });
    }
});
// DELETE /api/v1/properties/:id/images/:imageId - Delete property image
router.delete('/:id/images/:imageId', auth_1.authenticateToken, (0, authz_1.requireAuthz)(shared_1.Permissions.PROPERTIES_UPDATE), (0, validate_1.validateRequestBody)(shared_1.EmptyBodySchema), async (req, res, next) => {
    try {
        const propertyId = parseInt(req.params.id, 10);
        if (isNaN(propertyId))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        if (isNaN(propertyId))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        if (isNaN(propertyId))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        if (isNaN(propertyId))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        const imageId = parseInt(req.params.imageId, 10);
        if (isNaN(imageId))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        if (isNaN(imageId))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        if (isNaN(imageId))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        if (isNaN(imageId))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        const companyId = req.user.companyId;
        // Verify property belongs to company
        const property = await p.property.findFirst({
            where: { id: propertyId, company_id: companyId },
        });
        if (!property) {
            return res.status(404).json({ error: 'Property not found or unauthorized' });
        }
        // Verify image belongs to property
        const image = await p.propertyImage.findFirst({
            where: { id: imageId, property_id: propertyId },
        });
        if (!image) {
            return res.status(404).json({ error: 'Image not found' });
        }
        // Delete file from disk securely
        const storage = (0, storage_service_1.getPropertyImageStorage)();
        await storage.delete(image.image_url);
        // Delete record and auto-promote next image if needed
        await p.$transaction(async (tx) => {
            await tx.propertyImage.delete({ where: { id: imageId } });
            // If the deleted image was the primary one, promote the next available image
            if (image.is_primary) {
                const nextImage = await tx.propertyImage.findFirst({
                    where: { property_id: propertyId },
                    orderBy: { sort_order: 'asc' },
                });
                if (nextImage) {
                    await tx.propertyImage.update({
                        where: { id: nextImage.id },
                        data: { is_primary: true },
                    });
                }
            }
        });
        return res.status(200).json({ message: 'Image deleted successfully' });
    }
    catch (error) {
        logger_1.logger.error('Delete property image error:', error);
        if (error.status) {
            return next(error);
        }
        return res.status(500).json({ error: 'Failed to delete image' });
    }
});
// POST /api/v1/properties/:id/images/:imageId/approve - Approve image
router.post('/:id/images/:imageId/approve', auth_1.authenticateToken, (0, authz_1.requireAuthz)(shared_1.Permissions.PROPERTIES_DM_POLISH), (0, validate_1.validateRequestBody)(shared_1.EmptyBodySchema), async (req, res, next) => {
    try {
        const propertyId = parseInt(req.params.id, 10);
        if (isNaN(propertyId))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        if (isNaN(propertyId))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        if (isNaN(propertyId))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        if (isNaN(propertyId))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        const imageId = parseInt(req.params.imageId, 10);
        if (isNaN(imageId))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        if (isNaN(imageId))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        if (isNaN(imageId))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        if (isNaN(imageId))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        const companyId = req.user.companyId;
        const image = await p.propertyImage.findFirst({
            where: {
                id: imageId,
                property_id: propertyId,
                property: { company_id: companyId }
            },
        });
        if (!image) {
            return res.status(404).json({ error: 'Image not found' });
        }
        const updated = await p.propertyImage.update({
            where: { id: imageId },
            data: { status: 'APPROVED' },
        });
        return res.status(200).json({ message: 'Image approved', image: updated });
    }
    catch (error) {
        logger_1.logger.error('Approve image error:', error);
        if (error.status) {
            return next(error);
        }
        return res.status(500).json({ error: 'Failed to approve image' });
    }
});
// POST /api/v1/properties/:id/images/:imageId/reject - Reject image
router.post('/:id/images/:imageId/reject', auth_1.authenticateToken, (0, authz_1.requireAuthz)(shared_1.Permissions.PROPERTIES_DM_POLISH), (0, validate_1.validateRequestBody)(shared_1.EmptyBodySchema), async (req, res, next) => {
    try {
        const propertyId = parseInt(req.params.id, 10);
        if (isNaN(propertyId))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        if (isNaN(propertyId))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        if (isNaN(propertyId))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        if (isNaN(propertyId))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        const imageId = parseInt(req.params.imageId, 10);
        if (isNaN(imageId))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        if (isNaN(imageId))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        if (isNaN(imageId))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        if (isNaN(imageId))
            return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
        const companyId = req.user.companyId;
        const image = await p.propertyImage.findFirst({
            where: {
                id: imageId,
                property_id: propertyId,
                property: { company_id: companyId }
            },
        });
        if (!image) {
            return res.status(404).json({ error: 'Image not found' });
        }
        const updated = await p.propertyImage.update({
            where: { id: imageId },
            data: { status: 'REJECTED' },
        });
        return res.status(200).json({ message: 'Image rejected', image: updated });
    }
    catch (error) {
        logger_1.logger.error('Reject image error:', error);
        if (error.status) {
            return next(error);
        }
        return res.status(500).json({ error: 'Failed to reject image' });
    }
});
exports.default = router;
