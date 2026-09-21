import { PrismaClient } from '@prisma/client';

/**
 * Singleton Prisma Client instance for the API.
 * Prevents multiple instances from exhausting the connection pool,
 * especially during sequential test runs.
 */
export const prisma = new PrismaClient();

const dbUrl = process.env.DATABASE_URL || '';
const publicDbUrl = dbUrl.includes('connection_limit=')
  ? dbUrl.replace(/connection_limit=\d+/, 'connection_limit=3')
  : dbUrl.includes('?')
    ? `${dbUrl}&connection_limit=3`
    : `${dbUrl}?connection_limit=3`;

export const publicPrisma = new PrismaClient({
  datasources: {
    db: {
      url: publicDbUrl,
    },
  },
});

export default prisma;
