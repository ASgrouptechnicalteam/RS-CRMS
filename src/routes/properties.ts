import { prisma } from '../lib/prisma';
import { Router, Response , NextFunction} from 'express';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { requireAuthz } from '../middleware/authz';
import {
  PropertyCreateSchema,
  PropertyVerificationSchema,
  PropertyDMUpdateSchema,
  PropertyDMVerifyAsIsSchema,
  PropertyMDApprovalSchema,
  PropertyUpdateSchema,
  Permissions,
} from '../shared';
import { validateRequestBody } from '../middleware/validate';
import { PropertyService } from '../services/property.service';
import {
  propertyImageUpload,
  getPropertyImageStorage,
} from '../services/storage.service';
import { PrismaClient, Prisma } from '@prisma/client';

const router = Router();

const p = prisma;

// GET /api/v1/properties - List properties with brand and status filtering
router.get(
  '/',
  authenticateToken,
  requireAuthz(Permissions.PROPERTIES_READ),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { brand, status, project_id, unassigned, dm_executive_id } = req.query;
    const filters: { brand?: string; status?: string; project_id?: number; unassigned?: boolean; dm_executive_id?: number } = {
      brand: typeof brand === 'string' ? brand : undefined,
      status: typeof status === 'string' ? status : undefined,
      project_id: typeof project_id === 'string' ? parseInt(project_id, 10) : undefined,
      unassigned: unassigned === 'true',
      dm_executive_id: typeof dm_executive_id === 'string' ? parseInt(dm_executive_id, 10) : undefined,
    };

    // DM Executives automatically see only their own assigned-to-polish properties
    const userRoles: string[] = (req.user as any)?.roles || [];
    const isDMExecutiveOnly = userRoles.includes('digital marketing executive') &&
      !userRoles.some((r: string) => ['Digital Marketing head(manager)', 'Marketing Director', 'md', 'admin'].includes(r));
    if (isDMExecutiveOnly && !filters.dm_executive_id) {
      filters.dm_executive_id = req.user!.employeeId;
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 100);
    const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);

    const properties = await PropertyService.listProperties(req.user!, filters, limit, offset);
    return res.status(200).json({ properties, pagination: { limit, offset } });
  } catch (error: any) {
    console.error('Fetch properties error:', error);
    if (error.status) {
      return next(error);
    }
    return res.status(500).json({ error: 'Failed to fetch properties' });
  }
});

// POST /api/v1/properties - Create Property Listing
router.post(
  '/',
  authenticateToken,
  requireAuthz(Permissions.PROPERTIES_CREATE),
  validateRequestBody(PropertyCreateSchema),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const property = await PropertyService.createProperty(req.user!, req.body);
    return res.status(201).json({
      message: 'Property listing created and submitted for PM On-Site Verification',
      property,
    });
  } catch (error: any) {
    console.error('Create property error:', error);
    if (error.status) {
      return next(error);
    }
    return res.status(500).json({ error: 'Failed to create property listing' });
  }
});

// PUT /api/v1/properties/:id - Update Property Listing
router.put(
  '/:id',
  authenticateToken,
  requireAuthz(Permissions.PROPERTIES_UPDATE),
  validateRequestBody(PropertyUpdateSchema),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const propertyId = parseInt(req.params.id, 10);
      if (isNaN(propertyId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      if (isNaN(propertyId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      if (isNaN(propertyId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      if (isNaN(propertyId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      const property = await PropertyService.updateProperty(req.user!, propertyId, req.body);
      return res.status(200).json({
        message: 'Property listing updated successfully',
        property,
      });
    } catch (error: any) {
      console.error('Update property error:', error);
      if (error.status) {
        return next(error);
      }
      return res.status(500).json({ error: 'Failed to update property listing' });
    }
  }
);

// POST /api/v1/properties/:id/confirm-location - PM confirms on-site location details are accurate
// This is a prerequisite for the verify action — setting this flag is a distinct, explicit PM decision.
router.post(
  '/:id/confirm-location',
  authenticateToken,
  requireAuthz(Permissions.PROPERTIES_VERIFY),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const propertyId = parseInt(req.params.id, 10);
      if (isNaN(propertyId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      const result = await PropertyService.confirmLocationByPM(req.user!, propertyId);
      return res.status(200).json({
        message: `Location confirmed for property ${result.property_code}`,
        property: result,
      });
    } catch (error: any) {
      console.error('Confirm location error:', error);
      if (error.status) return next(error);
      return res.status(500).json({ error: 'Failed to confirm location' });
    }
  }
);

// POST /api/v1/properties/:id/verify - PM On-Site Verification Step
router.post(
  '/:id/verify',
  authenticateToken,
  requireAuthz(Permissions.PROPERTIES_VERIFY),
  validateRequestBody(PropertyVerificationSchema),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const propertyId = parseInt(req.params.id, 10);
      if (isNaN(propertyId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      if (isNaN(propertyId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      if (isNaN(propertyId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      if (isNaN(propertyId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      const updated = await PropertyService.verifyProperty(req.user!, propertyId, req.body);

      return res.status(200).json({
        message: `Property ${updated.property_code} verification updated to ${updated.status}`,
        property: updated,
      });
    } catch (error: any) {
      console.error('PM Verify error:', error);
      if (error.status) {
        return next(error);
      }
      return res.status(500).json({ error: 'Failed to execute PM verification step' });
    }
  }
);

// POST /api/v1/properties/:id/dm-polish - Digital Marketing Polish & SEO Tagging Step
router.post(
  '/:id/dm-polish',
  authenticateToken,
  requireAuthz(Permissions.PROPERTIES_DM_POLISH),
  validateRequestBody(PropertyDMUpdateSchema),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const propertyId = parseInt(req.params.id, 10);
      if (isNaN(propertyId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      if (isNaN(propertyId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      if (isNaN(propertyId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      if (isNaN(propertyId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      const updated = await PropertyService.dmPolishProperty(req.user!, propertyId, req.body);

      return res.status(200).json({
        message: `Property ${updated.property_code} polished by DM team and submitted for MD Approval`,
        property: updated,
      });
    } catch (error: any) {
      console.error('DM Polish error:', error);
      if (error.status) {
        return next(error);
      }
      return res.status(500).json({ error: 'Failed to execute DM polish step' });
    }
  }
);

// POST /api/v1/properties/:id/dm-verify-as-is - Digital Marketing Head "Verified As-Is" bypass
// Skips polish assignment and advances directly to PENDING_MD_APPROVAL.
// Uses same PROPERTIES_DM_POLISH permission gate as the standard polish path.
router.post(
  '/:id/dm-verify-as-is',
  authenticateToken,
  requireAuthz(Permissions.PROPERTIES_DM_POLISH),
  validateRequestBody(PropertyDMVerifyAsIsSchema),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const propertyId = parseInt(req.params.id, 10);
      if (isNaN(propertyId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      const updated = await PropertyService.dmVerifyAsIsProperty(req.user!, propertyId, req.body);

      return res.status(200).json({
        message: `Property ${updated.property_code} verified as-is by DM Head and submitted for MD Approval`,
        property: updated,
      });
    } catch (error: any) {
      console.error('DM Verify As-Is error:', error);
      if (error.status) {
        return next(error);
      }
      return res.status(500).json({ error: 'Failed to execute DM verify-as-is step' });
    }
  }
);

// POST /api/v1/properties/:id/md-approve - MD Final Approval Step (Go Live)
router.post(
  '/:id/md-approve',
  authenticateToken,
  requireAuthz(Permissions.PROPERTIES_MD_APPROVE),
  validateRequestBody(PropertyMDApprovalSchema),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const propertyId = parseInt(req.params.id, 10);
      if (isNaN(propertyId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      if (isNaN(propertyId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      if (isNaN(propertyId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      if (isNaN(propertyId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      const updated = await PropertyService.mdApproveProperty(req.user!, propertyId, req.body);

      return res.status(200).json({
        message: `Property ${updated.property_code} is now ${updated.status}`,
        property: updated,
      });
    } catch (error: any) {
      console.error('MD Approve error:', error);
      if (error.status) {
        return next(error);
      }
      return res.status(500).json({ error: 'Failed to execute MD approval step' });
    }
  }
);

// POST /api/v1/properties/:id/publications - Toggle publication for a brand
router.post(
  '/:id/publications',
  authenticateToken,
  requireAuthz(Permissions.PROPERTIES_UPDATE),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const propertyId = parseInt(req.params.id, 10);
      if (isNaN(propertyId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      if (isNaN(propertyId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      if (isNaN(propertyId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      if (isNaN(propertyId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      const { company_id, is_published } = req.body;

      if (!company_id || typeof is_published !== 'boolean') {
        return res.status(400).json({ error: 'company_id and is_published (boolean) are required' });
      }

      const publication = await PropertyService.togglePublication(
        req.user!,
        propertyId,
        company_id,
        is_published
      );

      return res.status(200).json({
        message: `Property ${is_published ? 'published' : 'unpublished'} successfully`,
        publication,
      });
    } catch (error: any) {
      console.error('Toggle publication error:', error);
      if (error.status) {
        return next(error);
      }
      return res.status(500).json({ error: 'Failed to toggle publication' });
    }
  }
);

// GET /api/v1/properties/:id/publications - List publications for a property
router.get(
  '/:id/publications',
  authenticateToken,
  requireAuthz(Permissions.PROPERTIES_READ),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const propertyId = parseInt(req.params.id, 10);
      if (isNaN(propertyId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      if (isNaN(propertyId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      if (isNaN(propertyId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      if (isNaN(propertyId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      const publications = await PropertyService.getPublications(req.user!, propertyId);
      return res.status(200).json({ publications });
    } catch (error: any) {
      console.error('Get publications error:', error);
      if (error.status) {
        return next(error);
      }
      return res.status(500).json({ error: 'Failed to fetch publications' });
    }
  }
);

// POST /api/v1/properties/:id/images - Upload property image
router.post(
  '/:id/images',
  authenticateToken,
  requireAuthz(Permissions.PROPERTIES_UPDATE),
  propertyImageUpload.single('image'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const propertyId = parseInt(req.params.id, 10);
      if (isNaN(propertyId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      if (isNaN(propertyId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      if (isNaN(propertyId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      if (isNaN(propertyId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      const companyId = req.user!.companyId;

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

      const storage = getPropertyImageStorage();
      const imageUrl = await storage.upload(req.file.buffer, propertyId);
      const { alt_text, sort_order, is_primary } = req.body;
      const isPrimaryBool = is_primary === 'true' || is_primary === true;

      let image;
      await p.$transaction(async (tx: Prisma.TransactionClient) => {
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
            uploaded_by_id: req.user!.employeeId,
            sort_order: sort_order ? parseInt(sort_order, 10) : 0,
            alt_text: alt_text || null,
            status: 'PENDING',
          },
        });
      });

      return res.status(201).json({ message: 'Image uploaded successfully', image });
    } catch (error: any) {
      console.error('Upload property image error:', error);
      if (error.status) {
        return next(error);
      }
      return res.status(500).json({ error: 'Failed to upload image' });
    }
  }
);

// PUT /api/v1/properties/:id/images/:imageId - Update image metadata
router.put(
  '/:id/images/:imageId',
  authenticateToken,
  requireAuthz(Permissions.PROPERTIES_UPDATE),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const propertyId = parseInt(req.params.id, 10);
      if (isNaN(propertyId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      if (isNaN(propertyId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      if (isNaN(propertyId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      if (isNaN(propertyId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      const imageId = parseInt(req.params.imageId, 10);
      if (isNaN(imageId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      if (isNaN(imageId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      if (isNaN(imageId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      if (isNaN(imageId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      const companyId = req.user!.companyId;

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
      const updateData: any = {};

      if (alt_text !== undefined) updateData.alt_text = alt_text || null;
      if (sort_order !== undefined) updateData.sort_order = parseInt(sort_order, 10);
      
      const isPrimaryBool = is_primary === 'true' || is_primary === true;
      if (is_primary !== undefined) updateData.is_primary = isPrimaryBool;

      let updated;
      await p.$transaction(async (tx: Prisma.TransactionClient) => {
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
    } catch (error: any) {
      console.error('Update property image error:', error);
      if (error.status) {
        return next(error);
      }
      return res.status(500).json({ error: 'Failed to update image' });
    }
  }
);

// DELETE /api/v1/properties/:id/images/:imageId - Delete property image
router.delete(
  '/:id/images/:imageId',
  authenticateToken,
  requireAuthz(Permissions.PROPERTIES_UPDATE),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const propertyId = parseInt(req.params.id, 10);
      if (isNaN(propertyId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      if (isNaN(propertyId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      if (isNaN(propertyId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      if (isNaN(propertyId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      const imageId = parseInt(req.params.imageId, 10);
      if (isNaN(imageId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      if (isNaN(imageId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      if (isNaN(imageId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      if (isNaN(imageId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      const companyId = req.user!.companyId;

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
      const storage = getPropertyImageStorage();
      await storage.delete(image.image_url);

      // Delete record and auto-promote next image if needed
      await p.$transaction(async (tx: Prisma.TransactionClient) => {
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
    } catch (error: any) {
      console.error('Delete property image error:', error);
      if (error.status) {
        return next(error);
      }
      return res.status(500).json({ error: 'Failed to delete image' });
    }
  }
);

// POST /api/v1/properties/:id/images/:imageId/approve - Approve image
router.post(
  '/:id/images/:imageId/approve',
  authenticateToken,
  requireAuthz(Permissions.PROPERTIES_DM_POLISH),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const propertyId = parseInt(req.params.id, 10);
      if (isNaN(propertyId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      if (isNaN(propertyId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      if (isNaN(propertyId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      if (isNaN(propertyId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      const imageId = parseInt(req.params.imageId, 10);
      if (isNaN(imageId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      if (isNaN(imageId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      if (isNaN(imageId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      if (isNaN(imageId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      const companyId = req.user!.companyId;

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
    } catch (error: any) {
      console.error('Approve image error:', error);
      if (error.status) {
        return next(error);
      }
      return res.status(500).json({ error: 'Failed to approve image' });
    }
  }
);

// POST /api/v1/properties/:id/images/:imageId/reject - Reject image
router.post(
  '/:id/images/:imageId/reject',
  authenticateToken,
  requireAuthz(Permissions.PROPERTIES_DM_POLISH),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const propertyId = parseInt(req.params.id, 10);
      if (isNaN(propertyId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      if (isNaN(propertyId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      if (isNaN(propertyId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      if (isNaN(propertyId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      const imageId = parseInt(req.params.imageId, 10);
      if (isNaN(imageId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      if (isNaN(imageId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      if (isNaN(imageId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      if (isNaN(imageId)) return next({ name: 'AppError', statusCode: 400, message: 'Invalid ID format' });
      const companyId = req.user!.companyId;

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
    } catch (error: any) {
      console.error('Reject image error:', error);
      if (error.status) {
        return next(error);
      }
      return res.status(500).json({ error: 'Failed to reject image' });
    }
  }
);

export default router;
