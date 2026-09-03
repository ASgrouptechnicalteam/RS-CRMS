import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';
import { Express } from 'express';
import { authenticateToken } from '../middleware/auth';
import { logger } from './logger';

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'CRM API',
      version: '1.0.0',
      description: 'API Documentation for the CRM application',
    },
    servers: [
      {
        url: '/api/v1',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
    },
    security: [
      {
        bearerAuth: [],
      },
    ],
  },
  apis: ['./src/routes/*.ts'], // Generate docs from route comments
};

const specs = swaggerJsdoc(options);

export const setupSwagger = (app: Express) => {
  // Option 1: Completely disable in production
  if (process.env.NODE_ENV === 'production' && process.env.ENABLE_SWAGGER !== 'true') {
    logger.info('[Swagger] Disabled in production environment.');
    // Add a simple disabled route to prevent confusion if someone tries to access it
    app.use('/api-docs', (req, res) => {
      res.status(403).json({ error: 'API Documentation is disabled in production.' });
    });
    return;
  }

  // Option 2: Gate behind authentication in non-production or if explicitly enabled
  // We use authenticateToken middleware to protect the route
  app.use(
    '/api-docs',
    authenticateToken,
    swaggerUi.serve as any,
    swaggerUi.setup(specs, { explorer: true }) as any,
  );

  logger.info('[Swagger] API Documentation initialized at /api-docs (Protected)');
};
