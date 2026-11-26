import { PrismaClient } from "@prisma/client";

// DATABASE_URL for any external Postgres; NETLIFY_DB_URL is the variable Netlify Database provides.
export const prisma = new PrismaClient({
  datasourceUrl: process.env.DATABASE_URL || process.env.NETLIFY_DB_URL,
  transactionOptions: {
    maxWait: 10000, // 10 seconds wait for connection
    timeout: 15000, // 15 seconds transaction timeout
  },
});