"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.setupSwagger = void 0;
const swagger_jsdoc_1 = __importDefault(require("swagger-jsdoc"));
const swagger_ui_express_1 = __importDefault(require("swagger-ui-express"));
const auth_1 = require("../middleware/auth");
const logger_1 = require("./logger");
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
const specs = (0, swagger_jsdoc_1.default)(options);
const setupSwagger = (app) => {
    // Option 1: Completely disable in production
    if (process.env.NODE_ENV === 'production' && process.env.ENABLE_SWAGGER !== 'true') {
        logger_1.logger.info('[Swagger] Disabled in production environment.');
        // Add a simple disabled route to prevent confusion if someone tries to access it
        app.use('/api-docs', (req, res) => {
            res.status(403).json({ error: 'API Documentation is disabled in production.' });
        });
        return;
    }
    // Option 2: Gate behind authentication in non-production or if explicitly enabled
    // We use authenticateToken middleware to protect the route
    app.use('/api-docs', auth_1.authenticateToken, swagger_ui_express_1.default.serve, swagger_ui_express_1.default.setup(specs, { explorer: true }));
    logger_1.logger.info('[Swagger] API Documentation initialized at /api-docs (Protected)');
};
exports.setupSwagger = setupSwagger;
