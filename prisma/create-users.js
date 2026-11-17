import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs"; // unga project-la 'bcrypt' iruntha 'bcrypt' nu mathikonga

const prisma = new PrismaClient();

async function main() {
  const adminPassword = await bcrypt.hash("Admin@123", 10);
  const salesPassword = await bcrypt.hash("Sales@123", 10);

  // 1. Create Admin Account
  const admin = await prisma.user.upsert({
    where: { email: "admin@neosolaris.com" },
    update: { passwordHash: adminPassword, role: "ADMIN", isActive: true },
    create: {
      email: "admin@neosolaris.com",
      name: "Neo Solaris Admin",
      passwordHash: adminPassword,
      role: "ADMIN",
      isActive: true,
    },
  });

  // 2. Create Sales Person Account
  const sales1 = await prisma.user.upsert({
    where: { email: "sales1@neosolaris.com" },
    update: { passwordHash: salesPassword, role: "SALES_STAFF", isActive: true },
    create: {
      email: "sales1@neosolaris.com",
      name: "Sales Executive 1",
      passwordHash: salesPassword,
      role: "SALES_STAFF",
      isActive: true,
      profile: {
        create: {
          phone: "9876543210",
          teamName: "Madurai Sales",
        },
      },
    },
  });

  console.log("✅ Users ready:", { admin: admin.email, sales1: sales1.email });
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());