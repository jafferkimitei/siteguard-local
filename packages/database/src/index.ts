import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';

export const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
dotenv.config({ path: resolve(ROOT_DIR, '.env') });

const Env = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default('redis://localhost:6380'),
  API_PORT: z.coerce.number().default(3000),
  DASHBOARD_ORIGIN: z.string().default('http://localhost:5173'),
  REPORTS_DIR: z.string().default('./reports'),
  K6_MODE: z.enum(['auto', 'local', 'docker']).default('auto'),
  K6_DOCKER_IMAGE: z.string().default('grafana/k6:latest'),
});
export const env = Env.parse(process.env);
export const reportsDir = resolve(ROOT_DIR, env.REPORTS_DIR);

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };
export const prisma = globalForPrisma.prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export * from '@prisma/client';

export const audit = (runId: string | null, kind: string, message: string, data?: object) =>
  prisma.auditEvent.create({ data: { runId, kind, message, data: data as never } });
