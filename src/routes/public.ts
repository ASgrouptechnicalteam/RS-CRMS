import { logger } from '../utils/logger';
import { prisma } from '../lib/prisma';
import { Router, Response } from 'express';
import { PrismaClient, Prisma } from '@prisma/client';
import { PublicLeadCreateSchema } from '../shared';
import { validateRequestBody } from '../middleware/validate';
import { publicReadLimiter, publicWriteLimiter } from '../middleware/rateLimiter';
import { correlationId } from '../middleware/correlationId';

const router = Router();

const p = prisma;

// Public-safe property allowlist (WR-1/WR-2/WR-3/WR-6)
const PUBLIC_PROPERTY_SELECT: Prisma.PropertySelect = {
  id: true,
  property_code: true,
  title: true,
  description: true,
  category: true,
  price: true,
  area_sqft: true,
  location: true,
  address: true,
  bedrooms: true,
  bathrooms: true,
  facing: true,
  amenities: true,
  possession_status: true,
  details: true,
  seo_title: true,
  seo_keywords: true,
  created_at: true,
  state: true,
  city: true,
  locality: true,
  pincode: true,
  listing_type: true,
  slug: true,
  // GPS intentionally EXCLUDED — internal only
  images: {
    where: { status: 'APPROVED' },
    select: {
      id: true,
      image_url: true,
      is_primary: true,
      alt_text: true,
      sort_order: true,
    },
    orderBy: [{ sort_order: 'asc' as const }, { created_at: 'asc' as const }],
  }
};

// Public-safe property subset for project detail (less than full property detail)
// Excludes: status (internal), GPS coordinates, seller info, internal workflow fields
const PUBLIC_PROJECT_PROPERTY_SELECT: Prisma.PropertySelect = {
  id: true,
  property_code: true,
  title: true,
  description: true,
  category: true,
  price: true,
  area_sqft: true,
  location: true,
  bedrooms: true,
  bathrooms: true,
  facing: true,
  amenities: true,
  possession_status: true,
  created_at: true,
  state: true,
  city: true,
  locality: true,
  pincode: true,
  listing_type: true,
  slug: true,
  images: {
    where: { status: 'APPROVED' },
    select: {
      id: true,
      image_url: true,
      is_primary: true,
      alt_text: true,
      sort_order: true,
    },
    orderBy: [{ sort_order: 'asc' as const }, { created_at: 'asc' as const }],
  }
};

// WR-5/WR-6: Public-safe project allowlist
const PUBLIC_PROJECT_SELECT: Prisma.ProjectSelect = {
  id: true,
  project_code: true,
  name: true,
  description: true,
  location: true,
  total_area: true,
  launch_date: true,
  status: true,
  amenities: true,
  created_at: true,
  slug: true,
  // company_id EXCLUDED — internal
  // assigned_pm_id EXCLUDED — internal
  // branch_id EXCLUDED — internal
};

// WR-5: Project detail extends list with properties
const PUBLIC_PROJECT_DETAIL_SELECT: Prisma.ProjectSelect = {
  ...PUBLIC_PROJECT_SELECT,
  properties: {
    select: PUBLIC_PROJECT_PROPERTY_SELECT,
    orderBy: { created_at: 'desc' as const },
  },
};

// Property detail adds a minimal project subset (WR-5 extends this pattern)
const PUBLIC_PROPERTY_DETAIL_SELECT: Prisma.PropertySelect = {
  ...PUBLIC_PROPERTY_SELECT,
  project: {
    select: {
      id: true,
      project_code: true,
      name: true,
      location: true,
      status: true,
    },
  },
};

// Public API Key Middleware
const authenticatePublicKey = async (req: any, res: Response, next: any) => {
  const apiKey = req.header('x-api-key');
  if (!apiKey) {
    return res.status(401).json({ error: 'API Key missing' });
  }

  try {
    const validKey = await p.publicApiKey.findUnique({
      where: { api_key: apiKey },
      include: { company: true },
    });

    if (!validKey || !validKey.is_active) {
      return res.status(401).json({ error: 'Invalid or inactive API Key' });
    }

    req.apiKeyContext = validKey;
    next();
  } catch (err) {
    logger.error('API Key Auth error:', err);
    res.status(500).json({ error: 'Internal server error during authentication' });
  }
};

router.use(correlationId);
router.use(publicReadLimiter);
router.use(authenticatePublicKey);

// GET /api/v1/public/:brand/properties
router.get('/:brand/properties', async (req: any, res: Response) => {
  try {
    const { brand } = req.params;
    const { city, locality, location, listing_type, category, price_min, price_max, bedrooms, bedrooms_min, bedrooms_max, bathrooms, area_min, area_max, sort } = req.query;
    let companyId: number | null = null;

    if (brand.toLowerCase() === 'rrh') {
      companyId = req.apiKeyContext.company_id;
    } else if (brand.toLowerCase() === 'sonthillu') {
      companyId = req.apiKeyContext.company_id;
    } else {
      return res.status(400).json({ error: 'Invalid brand specified in URL' });
    }

// Helper: safely convert query param to number, returns undefined for invalid
    const toNum = (v: any) => {
      if (v === null || v === undefined || v === '') return undefined;
      const n = Number(v);
      if (n !== n || !isFinite(n)) return undefined; // NaN or Infinity
      return n;
    };

    const priceMin = toNum(price_min);
    const priceMax = toNum(price_max);
    const bedRooms = toNum(bedrooms);
    const bedRoomsMin = toNum(bedrooms_min);
    const bedRoomsMax = toNum(bedrooms_max);
    const bathRooms = toNum(bathrooms);
    const areaMin = toNum(area_min);
    const areaMax = toNum(area_max);
    const sortIn = sort as string;
    const pageNum = toNum(req.query.page);
    const limitNum = toNum(req.query.limit);

    // WR-7: Validation — min <= max for price and area (only when both provided)
    if (priceMin !== undefined && priceMax !== undefined && priceMin > priceMax) {
      return res.status(400).json({ error: 'price_min must be <= price_max' });
    }
    if (areaMin !== undefined && areaMax !== undefined && areaMin > areaMax) {
      return res.status(400).json({ error: 'area_min must be <= area_max' });
    }

    // WR-7: Validation — invalid numeric inputs → 400 (only when param provided in URL)
    // toNum returns undefined for both "not provided" and "invalid value"
    // Check raw query param to distinguish: if provided but invalid → 400
    const hasPriceMin = price_min !== undefined;
    const hasPriceMax = price_max !== undefined;
    const hasAreaMin = area_min !== undefined;
    const hasAreaMax = area_max !== undefined;
    const hasPage = req.query.page !== undefined;
    const hasLimit = req.query.limit !== undefined;

    if (hasPriceMin && priceMin === undefined) {
      return res.status(400).json({ error: 'Invalid price_min value' });
    }
    if (hasPriceMax && priceMax === undefined) {
      return res.status(400).json({ error: 'Invalid price_max value' });
    }
    if (hasAreaMin && areaMin === undefined) {
      return res.status(400).json({ error: 'Invalid area_min value' });
    }
    if (hasAreaMax && areaMax === undefined) {
      return res.status(400).json({ error: 'Invalid area_max value' });
    }
    if (hasPage && pageNum === undefined) {
      return res.status(400).json({ error: 'Invalid page value' });
    }
    if (hasLimit && limitNum === undefined) {
      return res.status(400).json({ error: 'Invalid limit value' });
    }

    // WR-7: Validation — page >= 1, limit >= 1, max limit 50
    const page = pageNum !== undefined && pageNum >= 1 ? pageNum : 1;
    let limit = limitNum !== undefined && limitNum >= 1 ? limitNum : 20;
    if (limit > 50) {
      return res.status(400).json({ error: 'Limit must not exceed 50' });
    }
    limit = Math.min(limit, 50);

    // Brand / publication / availability foundation (unchanged)
    const publishedPropertyIds = await p.propertyPublication.findMany({
      where: {
        company_id: companyId as number,
        is_published: true,
      },
      select: { property_id: true },
    });

    const propertyIds = publishedPropertyIds.map((pp: any) => pp.property_id);

    if (propertyIds.length === 0) {
      return res.status(200).json([]);
    }

    // Build where condition with mandatory public restrictions
    const whereCondition: any = {
      id: { in: propertyIds },
      OR: [
        { status: 'LIVE' },
        {
          status: 'LOCKED',
          locked_until: { lt: new Date() },
        },
      ],
    };

    // WR-7: Price range filter (price >= priceMin AND price <= priceMax)
    if (priceMin !== undefined && priceMax !== undefined) {
      whereCondition.price = { gte: priceMin, lte: priceMax };
    } else if (priceMin !== undefined) {
      whereCondition.price = { gte: priceMin };
    } else if (priceMax !== undefined) {
      whereCondition.price = { lte: priceMax };
    }

    // WR-7: Bedrooms filter
    let finalBedroomsMin: number | undefined = undefined;
    if (bedRooms !== undefined && bedRooms >= 0) {
      finalBedroomsMin = bedRooms;
    }
    if (bedRoomsMin !== undefined && bedRoomsMin >= 0) {
      if (finalBedroomsMin !== undefined) {
        finalBedroomsMin = Math.max(finalBedroomsMin, bedRoomsMin);
      } else {
        finalBedroomsMin = bedRoomsMin;
      }
    }

    if (finalBedroomsMin !== undefined && bedRoomsMax !== undefined && finalBedroomsMin > bedRoomsMax) {
      return res.status(400).json({ error: 'effective bedrooms minimum must be <= bedrooms_max' });
    }

    if (finalBedroomsMin !== undefined || (bedRoomsMax !== undefined && bedRoomsMax >= 0)) {
      whereCondition.bedrooms = {};
      if (finalBedroomsMin !== undefined) {
        whereCondition.bedrooms.gte = finalBedroomsMin;
      }
      if (bedRoomsMax !== undefined && bedRoomsMax >= 0) {
        whereCondition.bedrooms.lte = bedRoomsMax;
      }
    }

    // New string filters
    if (city !== undefined && typeof city === 'string' && city.trim() !== '') {
      whereCondition.city = city.trim();
    }
    if (locality !== undefined && typeof locality === 'string' && locality.trim() !== '') {
      whereCondition.locality = locality.trim();
    }

    // Phase 3: Location search (tokenized OR search across city/locality)
    if (location !== undefined && typeof location === 'string' && location.trim() !== '') {
      const tokens = location.split(',').map((t: string) => t.trim()).filter(Boolean);
      const uniqueTokens: string[] = [];
      const seenLower = new Set<string>();
      for (const t of tokens) {
        const lower = t.toLowerCase();
        if (!seenLower.has(lower)) {
          seenLower.add(lower);
          uniqueTokens.push(t);
        }
      }
      if (uniqueTokens.length > 2) {
        return res.status(400).json({ error: 'Location search supports a maximum of 2 tokens (e.g., Locality, City)' });
      }
      if (uniqueTokens.length > 0) {
        whereCondition.AND = whereCondition.AND || [];
        for (const token of uniqueTokens) {
          whereCondition.AND.push({
            OR: [
              { city: { equals: token } },
              { locality: { equals: token } }
            ]
          });
        }
      }
    }
    if (category !== undefined && typeof category === 'string' && category.trim() !== '') {
      whereCondition.category = category.trim();
    }
    if (listing_type !== undefined && typeof listing_type === 'string' && listing_type.trim() !== '') {
      whereCondition.listing_type = listing_type.trim();
    }

    // WR-7: Bathrooms filter (bathrooms >= requested value)
    if (bathRooms !== undefined && bathRooms >= 0) {
      whereCondition.bathrooms = { gte: bathRooms };
    }

    // WR-7: Area range filter using area_sqft
    if (areaMin !== undefined && areaMax !== undefined) {
      whereCondition.area_sqft = { gte: areaMin, lte: areaMax };
    } else if (areaMin !== undefined) {
      whereCondition.area_sqft = { gte: areaMin };
    } else if (areaMax !== undefined) {
      whereCondition.area_sqft = { lte: areaMax };
    }

    // WR-7: Sorting — only validated deterministic values
    const sortValues = ['newest', 'price-asc', 'price-desc'];

    // If sort is omitted (undefined), default to newest.
    // If sort is provided but not in the validated list, return 400.
    let sortBy: any;
    if (sortIn === undefined) {
      sortBy = 'newest';
    } else if (sortValues.includes(sortIn)) {
      sortBy = sortIn;
    } else {
      return res.status(400).json({ error: 'Invalid sort value' });
    }

    const orderBy: any = {};
    if (sortBy === 'newest') {
      orderBy.created_at = 'desc';
    } else if (sortBy === 'price-asc') {
      orderBy.price = 'asc';
    } else if (sortBy === 'price-desc') {
      orderBy.price = 'desc';
    }

    // WR-7: Pagination — page and limit with defaults and max
    const skip = (page - 1) * limit;
    const take = limit;

    // Count total for pagination metadata (after all filters applied to published set)
    const total = await p.property.count({
      where: whereCondition,
    });

    const properties = await p.property.findMany({
      where: whereCondition,
      select: PUBLIC_PROPERTY_SELECT,
      orderBy: orderBy,
      skip: skip,
      take: take,
    });

    res.status(200).json(properties);
  } catch (error) {
    logger.error('Fetch public properties error:', error);
    res.status(500).json({ error: 'Failed to fetch properties' });
  }
});

// GET /api/v1/public/:brand/properties/:id — public property detail
// Re-checks publication and availability on every request (never trusts list-state).
router.get('/:brand/properties/:id', async (req: any, res: Response) => {
  try {
    const { brand, id } = req.params;

    if (brand.toLowerCase() !== 'rrh' && brand.toLowerCase() !== 'sonthillu') {
      return res.status(400).json({ error: 'Invalid brand specified in URL' });
    }

    const propertyId = Number(id);
    if (!Number.isInteger(propertyId) || propertyId <= 0) {
      return res.status(404).json({ error: 'Property not found or not available' });
    }

    const companyId = req.apiKeyContext.company_id;

    // Publication re-check: must be published to THIS company's brand feed.
    const publication = await p.propertyPublication.findFirst({
      where: {
        property_id: propertyId,
        company_id: companyId as number,
        is_published: true,
      },
    });

    if (!publication) {
      return res.status(404).json({ error: 'Property not found or not available' });
    }

    // Availability re-check: only LIVE or expired-LOCKED records are publicly visible.
    const property = await p.property.findFirst({
      where: {
        id: propertyId,
        OR: [
          { status: 'LIVE' },
          {
            status: 'LOCKED',
            locked_until: { lt: new Date() },
          },
        ],
      },
      select: PUBLIC_PROPERTY_DETAIL_SELECT,
    });

    if (!property) {
      return res.status(404).json({ error: 'Property not found or not available' });
    }

    res.status(200).json(property);
  } catch (error) {
    logger.error('Fetch public property detail error:', error);
    res.status(500).json({ error: 'Failed to fetch property detail' });
  }
});

// ─── WR-5: Public Project Endpoints ──────────────────────────────────────────

// Brand → brand_type mapping (WR-1 established: RRH=Commercial/Plots, Sonthillu=Residential)
const BRAND_TYPE_MAP: Record<string, string> = {
  rrh: 'RADHA_REAL_HOMES',
  sonthillu: 'SONTHILLU',
};

// Helper: derive inventory summary from properties in a project
// Counts all properties in the project regardless of publication status,
// but excludes CANCELLED properties from the total.
function deriveInventorySummary(properties: any[]) {
  let total = 0;
  let available = 0;
  let reserved = 0;
  let sold = 0;
  const now = new Date();

  for (const prop of properties) {
    // Skip cancelled properties entirely
    if (prop.status === 'CANCELLED') continue;

    total++;

    if (prop.status === 'LIVE') {
      available++;
    } else if (prop.status === 'LOCKED') {
      if (prop.locked_until && prop.locked_until < now) {
        available++; // expired lock = available
      } else {
        reserved++; // active lock = reserved
      }
    } else if (prop.status === 'BOOKED' || prop.status === 'SOLD') {
      sold++;
    }
    // PENDING_* / REJECTED: count in total but not in available/reserved/sold
  }

  return { total, available, reserved, sold };
}

// GET /api/v1/public/:brand/projects — list projects with published properties for this brand
router.get('/:brand/projects', async (req: any, res: Response) => {
  try {
    const { brand } = req.params;
    const brandLower = brand.toLowerCase();

    if (brandLower !== 'rrh' && brandLower !== 'sonthillu') {
      return res.status(400).json({ error: 'Invalid brand specified in URL' });
    }

    const companyId = req.apiKeyContext.company_id;
    const brandType = BRAND_TYPE_MAP[brandLower];

    // Find projects that have at least one property:
    // 1. of the matching brand_type (RRH → RADHA_REAL_HOMES, Sonthillu → SONTHILLU)
    // 2. published to this company via PropertyPublication
    const projects = await p.project.findMany({
      where: {
        properties: {
          some: {
            brand_type: brandType,
            publications: {
              some: {
                company_id: companyId as number,
                is_published: true,
              },
            },
          },
        },
        status: { not: 'CANCELLED' },
      },
      select: PUBLIC_PROJECT_SELECT,
      orderBy: { created_at: 'desc' },
    });

    // Derive inventory summary for each project
    const projectsWithInventory = await Promise.all(
      projects.map(async (project: any) => {
        const allProperties = await p.property.findMany({
          where: { project_id: project.id },
          select: {
            status: true,
            locked_until: true,
          },
        });

        const inventory_summary = deriveInventorySummary(allProperties);
        return { ...project, inventory_summary };
      })
    );

    res.status(200).json(projectsWithInventory);
  } catch (error) {
    logger.error('Fetch public projects error:', error);
    res.status(500).json({ error: 'Failed to fetch projects' });
  }
});

// GET /api/v1/public/:brand/projects/:id — public project detail
// Returns 404 when project does not exist or has no published properties for this brand.
router.get('/:brand/projects/:id', async (req: any, res: Response) => {
  try {
    const { brand, id } = req.params;
    const brandLower = brand.toLowerCase();

    if (brandLower !== 'rrh' && brandLower !== 'sonthillu') {
      return res.status(400).json({ error: 'Invalid brand specified in URL' });
    }

    const projectId = Number(id);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      return res.status(404).json({ error: 'Project not found or not available' });
    }

    const companyId = req.apiKeyContext.company_id;
    const brandType = BRAND_TYPE_MAP[brandLower];

    // Verify project exists and has at least one published property of this brand for this company
    const publicationCheck = await p.propertyPublication.findFirst({
      where: {
        company_id: companyId as number,
        is_published: true,
        property: {
          project_id: projectId,
          brand_type: brandType,
        },
      },
    });

    if (!publicationCheck) {
      return res.status(404).json({ error: 'Project not found or not available' });
    }

    // Fetch project with properties and approved images
    const project = await p.project.findFirst({
      where: { id: projectId },
      select: PUBLIC_PROJECT_DETAIL_SELECT,
    });

    if (!project) {
      return res.status(404).json({ error: 'Project not found or not available' });
    }

    // Derive inventory summary from all properties in the project
    const allProperties = await p.property.findMany({
      where: { project_id: projectId },
      select: {
        status: true,
        locked_until: true,
      },
    });

    const inventory_summary = deriveInventorySummary(allProperties);

    res.status(200).json({ ...project, inventory_summary });
  } catch (error) {
    logger.error('Fetch public project detail error:', error);
    res.status(500).json({ error: 'Failed to fetch project detail' });
  }
});

// POST /api/v1/public/:brand/leads
router.post('/:brand/leads', publicWriteLimiter, validateRequestBody(PublicLeadCreateSchema), async (req: any, res: Response) => {
  try {
    const { brand } = req.params;
    const { customer_name, phone, email, notes, property_type_preference, preferred_location, budget_max, enquiry_type, preferred_contact_time, property_ids, project_id } = req.body;

    const companyId = req.apiKeyContext.company_id;

    if (brand.toLowerCase() !== 'rrh' && brand.toLowerCase() !== 'sonthillu') {
      return res.status(400).json({ error: 'Invalid brand specified in URL' });
    }

    // Auto-generate Lead Code
    const year = new Date().getFullYear();
    const count = await p.lead.count();
    const leadCode = `RRH-LD-${year}-${String(count + 1).padStart(4, '0')}`;

    // Create the lead
    const newLead = await p.lead.create({
      data: {
        lead_code: leadCode,
        company_id: companyId as number,
        customer_name,
        phone,
        email,
        source: 'WEBSITE',
        status: 'NEW',
        property_type_preference: property_type_preference || 'APARTMENT',
        preferred_location,
        budget_max: budget_max ? Number(budget_max) : null,
        enquiry_type,
        preferred_contact_time,
        property_ids,
        project_id,
        notes,
      },
    });

    res.status(201).json({ message: 'Lead captured successfully', leadId: newLead.id });
  } catch (error) {
    logger.error('Public lead creation error:', error);
    res.status(500).json({ error: 'Failed to create lead' });
  }
});

export default router;
