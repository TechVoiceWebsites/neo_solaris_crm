import { createCrmServer } from "./createServer.js";
import { env } from "./config/env.js";
import { prisma } from "./config/db.js";

async function warmUpDb() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    console.log("Database connection warmed up");
  } catch (err) {
    console.error("DB warm-up ping failed:", err.message);
  }
}

createCrmServer().listen(env.port, async () => {
  console.log(`CRM API on :${env.port}`);
  await warmUpDb();
  // Keep Supabase pooler connection alive every 4 minutes
  setInterval(warmUpDb, 4 * 60 * 1000);
});