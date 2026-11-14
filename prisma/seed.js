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

const pw = process.env.SEED_ADMIN_PASSWORD;
if (pw) {
  const passwordHash = await bcrypt.hash(pw, 12);
  await prisma.user.upsert({
    where: { email: "admin@neosolaris.com" },
    update: { passwordHash, isActive: true },
    create: {
      email: "admin@neosolaris.com",
      name: "Admin",
      role: "ADMIN",
      passwordHash,
      profile: { create: {} },
    },
  });
}

console.log("Seed complete");
await prisma.$disconnect();