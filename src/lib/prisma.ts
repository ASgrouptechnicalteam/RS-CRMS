import { PrismaClient } from '@prisma/client';

/**
 * Singleton Prisma Client instance for the API.
 * Prevents multiple instances from exhausting the connection pool,
 * especially during sequential test runs.
 */
export const prisma = new PrismaClient();

export default prisma;
