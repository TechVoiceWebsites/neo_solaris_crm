import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient({
  datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL,
});

const sources = [
  ["INDIAMART", "IndiaMART"],
  ["PUREPOWER", "PUREPower Referrals"],
  ["WEBSITE", "Website"],
  ["META", "Facebook / Instagram"],
  ["DIRECT", "Direct Enquiries"],
];

const stages = [
  "New Lead",
  "Discussion",
  "Quotation",
  "Negotiation",
  "Order Confirmation",
  "Installation",
  "Lost",
];

for (const [code, name] of sources) {
  await prisma.leadSource.upsert({
    where: { code },
    update: { name },
    create: { code, name },
  });
}

await prisma.pipelineStage.deleteMany({
  where: { name: { notIn: stages } },
});

for (const [i, name] of stages.entries()) {
  await prisma.pipelineStage.upsert({
    where: { name },
    update: {
      position: i + 1,
      isWon: name === "Order Confirmation" || name === "Installation",
      isLost: name === "Lost",
    },
    create: {
      name,
      position: i + 1,
      isWon: name === "Order Confirmation" || name === "Installation",
      isLost: name === "Lost",
    },
  });
}

// 1. Admin Account
const adminPw = process.env.SEED_ADMIN_PASSWORD || "Admin@123";
const adminHash = await bcrypt.hash(adminPw, 12);
await prisma.user.upsert({
  where: { email: "admin@neosolaris.com" },
  update: { passwordHash: adminHash, role: "ADMIN", isActive: true },
  create: {
    email: "admin@neosolaris.com",
    name: "Admin",
    role: "ADMIN",
    passwordHash: adminHash,
    profile: { create: {} },
  },
});

// 2. Sales Staff Account(s) - pudhu sales persons venumna ithula add pannikalam
const salesStaffList = [
  {
    email: "sales1@neosolaris.com",
    name: "Sales Person 1",
    password: process.env.SEED_SALES_PASSWORD || "Sales@123",
    phone: "9876543210",
    teamName: "Sales Team",
  },
];

for (const staff of salesStaffList) {
  const staffHash = await bcrypt.hash(staff.password, 12);
  await prisma.user.upsert({
    where: { email: staff.email },
    update: {
      name: staff.name,
      passwordHash: staffHash,
      role: "SALES_STAFF",
      isActive: true,
    },
    create: {
      email: staff.email,
      name: staff.name,
      role: "SALES_STAFF",
      passwordHash: staffHash,
      profile: {
        create: {
          phone: staff.phone,
          teamName: staff.teamName,
        },
      },
    },
  });
}

console.log("Seed complete: Admin & Sales Staff ready!");
await prisma.$disconnect();