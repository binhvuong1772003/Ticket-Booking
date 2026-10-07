// Ping mọi database mà services dùng — load .env của từng service, instantiate
// Prisma client đã generate, chạy query tối thiểu. Không in URL/credentials.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SERVICES = [
  {
    name: 'auth',
    envFile: 'apps/auth-service/.env',
    client: '../apps/auth-service/src/generated/auth-prisma/index.js',
    kind: 'pg',
  },
  {
    name: 'booking',
    envFile: 'apps/booking-service/.env',
    client: '../apps/booking-service/src/generated/booking-prisma/index.js',
    kind: 'mongo',
  },
  {
    name: 'event',
    envFile: 'apps/event-service/.env',
    client: '@prisma/client',
    kind: 'mongo',
  },
  {
    name: 'inventory',
    envFile: 'apps/inventory-service/.env',
    client: '../apps/inventory-service/src/generated/inventory-prisma/index.js',
    kind: 'mongo',
  },
  {
    name: 'notification',
    envFile: 'apps/notification-service/.env',
    client:
      '../apps/notification-service/src/generated/notification-prisma/index.js',
    kind: 'mongo',
  },
  {
    name: 'payment',
    envFile: 'apps/payment-service/.env',
    client: '../apps/payment-service/src/generated/payment-prisma/index.js',
    kind: 'mongo',
  },
  {
    name: 'ticket',
    envFile: 'apps/ticket-service/.env',
    client: '../apps/ticket-service/src/generated/ticket-prisma/index.js',
    kind: 'pg',
  },
];

function loadEnv(path) {
  try {
    const content = readFileSync(path, 'utf8');
    const env = {};
    for (const line of content.split('\n')) {
      const match = line.trim().match(/^([A-Z_]+)=(.*)$/);
      if (match) {
        env[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
      }
    }
    return env;
  } catch {
    return null;
  }
}

async function ping(service) {
  const env = loadEnv(resolve(ROOT, service.envFile));
  if (!env) return `${service.name.padEnd(13)} SKIP   no .env`;
  if (!env.DATABASE_URL)
    return `${service.name.padEnd(13)} SKIP   no DATABASE_URL in .env`;

  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    const mod = await import(service.client);
    const PrismaClient = mod.PrismaClient ?? mod.default;
    const prisma = new PrismaClient();
    try {
      if (service.kind === 'pg') {
        await prisma.$queryRaw`SELECT 1`;
      } else {
        await prisma.$runCommandRaw({ ping: 1 });
      }
      let extra = '';
      if (env.DIRECT_URL) {
        try {
          const direct = new PrismaClient({ datasourceUrl: env.DIRECT_URL });
          await direct.$queryRaw`SELECT 1`;
          await direct.$disconnect();
          extra = ' (+direct ok)';
        } catch (e) {
          extra = ` (+direct FAIL: ${String(e).slice(0, 80)})`;
        }
      }
      await prisma.$disconnect();
      return `${service.name.padEnd(13)} OK     ${service.kind}${extra}`;
    } catch (e) {
      await prisma.$disconnect().catch(() => {});
      return `${service.name.padEnd(13)} FAIL   ${String(e).split('\n')[0].slice(0, 120)}`;
    }
  } catch (e) {
    return `${service.name.padEnd(13)} ERROR  ${String(e).split('\n')[0].slice(0, 120)}`;
  } finally {
    process.env = saved;
  }
}

for (const service of SERVICES) {
  console.log(await ping(service));
}
