import 'dotenv/config';
import { PrismaClient } from '../../generated/auth-prisma/index.js';

export const db = new PrismaClient();
