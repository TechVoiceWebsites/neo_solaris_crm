import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient({
  datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL,
});

const requiredStages = [
  "New Lead",
  "Discussion",
  "Quotation",
  "Negotiation",
  "Order Confirmation",
  "Installation",
  "Completed",
  "Lost",
];

try {
  // Avoid an interactive transaction here. Each update is a short,
  // independent Prisma operation; the script is safe to rerun if interrupted.
  const existingStages = await prisma.pipelineStage.findMany({
    orderBy: { position: "asc" },
    select: { id: true },
  });

  // Move current records to distinct temporary positions first, avoiding
  // collisions with the final unique position values.
  for (const [index, stage] of existingStages.entries()) {
    await prisma.pipelineStage.update({
      where: { id: stage.id },
      data: { position: 10000 + index },
    });
  }

  // Ensure the eight expected stages exist in the correct order.
  for (const [index, name] of requiredStages.entries()) {
    await prisma.pipelineStage.upsert({
      where: { name },
      update: {
        position: index + 1,
        isWon: name === "Completed",
        isLost: name === "Lost",
      },
      create: {
        name,
        position: index + 1,
        isWon: name === "Completed",
        isLost: name === "Lost",
      },
    });
  }

  console.log("Completed stage is now available.");
  console.log("Pipeline stages updated successfully.");
  console.log("Only Completed is marked WON; only Lost is marked LOST.");
} catch (error) {
  console.error("Could not update pipeline stages:", error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
